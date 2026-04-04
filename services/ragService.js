// ══════════════════════════════════════════════════════════════
// ── RAG SERVICE — Enterprise Vector Search for Large Clinics
// ── Handles: Titan Embeddings, smart text chunking, pgvector search
// ══════════════════════════════════════════════════════════════

const { InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");

const TITAN_MODEL_ID = "amazon.titan-embed-text-v2:0";
const EMBEDDING_DIMENSIONS = 1024;
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;

/**
 * Initialize RAG service with shared dependencies
 */
function createRagService({ bedrockClient, pool }) {

  // ── C1: Get embedding vector from AWS Titan
  async function getEmbedding(text) {
    const command = new InvokeModelCommand({
      modelId: TITAN_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        inputText: text,
        dimensions: EMBEDDING_DIMENSIONS,
        normalize: true,
      }),
    });

    const response = await bedrockClient.send(command);
    const result = JSON.parse(new TextDecoder().decode(response.body));
    return result.embedding; // number[] of length 1024
  }

  // ── C2: Search clinic_vectors by cosine similarity
  async function searchClinicVectors(clinicId, queryText, topK = 3) {
    // Embed the patient's question
    const queryEmbedding = await getEmbedding(queryText);
    const embeddingStr = `[${queryEmbedding.join(",")}]`;

    // pgvector cosine distance: <=> operator (lower = more similar)
    const result = await pool.query(
      `SELECT content, 1 - (embedding <=> $1::vector) AS similarity
       FROM clinic_vectors
       WHERE clinic_id = $2
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [embeddingStr, clinicId, topK]
    );

    return result.rows; // [{ content, similarity }, ...]
  }

  // ── C4: Smart text chunking — respects line breaks, never splits prices
  //
  // Strategy: 1000-char chunks with strict 200-char overlap.
  // Break priority: line break > sentence end (.) > word boundary (space)
  // By always breaking at whitespace boundaries, prices like "15,000د"
  // or "8000-15000د" are never split down the middle.
  function chunkText(text) {
    if (!text || text.length <= CHUNK_SIZE) {
      return text ? [text.trim()] : [];
    }

    const chunks = [];
    let pos = 0;

    while (pos < text.length) {
      let end = Math.min(pos + CHUNK_SIZE, text.length);

      // If not the last chunk, find a smart break point
      if (end < text.length) {
        // Search zone: last CHUNK_OVERLAP chars of the chunk
        const searchFrom = Math.max(pos + 1, end - CHUNK_OVERLAP);

        // Priority 1: Line break (best — never splits any content)
        const lineBreak = text.lastIndexOf("\n", end - 1);
        if (lineBreak >= searchFrom) {
          end = lineBreak + 1;
        } else {
          // Priority 2: Sentence end — period followed by whitespace
          let sentenceEnd = -1;
          for (let i = end - 1; i >= searchFrom; i--) {
            if (text[i] === "." && i + 1 < text.length && /\s/.test(text[i + 1])) {
              sentenceEnd = i + 1;
              break;
            }
          }
          if (sentenceEnd >= searchFrom) {
            end = sentenceEnd;
          } else {
            // Priority 3: Space (word boundary — protects prices)
            const space = text.lastIndexOf(" ", end - 1);
            if (space >= searchFrom) {
              end = space + 1;
            }
            // Else: hard cut at CHUNK_SIZE (extremely rare — text with no spaces for 1000 chars)
          }
        }
      }

      const chunk = text.slice(pos, end).trim();
      if (chunk.length > 0) {
        chunks.push(chunk);
      }

      // Next chunk starts CHUNK_OVERLAP chars before current end
      const nextPos = end - CHUNK_OVERLAP;
      pos = nextPos > pos ? nextPos : end; // Safety: always move forward
    }

    return chunks;
  }

  // ── C4: Chunk text and embed all chunks into clinic_vectors
  async function chunkAndEmbed(clinicId, fullText, clinicSummary) {
    if (!fullText) throw new Error("No text to embed");

    // Step 1: Delete old vectors for this clinic (re-processing)
    await pool.query("DELETE FROM clinic_vectors WHERE clinic_id = $1", [clinicId]);
    console.log(`Cleared old vectors for clinic ${clinicId}`);

    // Step 2: Chunk the text
    const chunks = chunkText(fullText);
    console.log(`Split text (${fullText.length} chars) into ${chunks.length} chunks`);

    // Step 3: Embed each chunk and insert into clinic_vectors
    let inserted = 0;
    for (const chunk of chunks) {
      try {
        const embedding = await getEmbedding(chunk);
        const embeddingStr = `[${embedding.join(",")}]`;

        await pool.query(
          `INSERT INTO clinic_vectors (clinic_id, content, embedding)
           VALUES ($1, $2, $3::vector)`,
          [clinicId, chunk, embeddingStr]
        );
        inserted++;
      } catch (err) {
        console.error(`Failed to embed chunk ${inserted + 1}:`, err.message);
        // Continue with remaining chunks — don't abort entire process
      }
    }

    // Step 4: Update clinic record
    await pool.query(
      `UPDATE clinics SET use_rag = TRUE, clinic_summary = $1 WHERE phone_number_id = $2`,
      [clinicSummary || "", clinicId]
    );

    console.log(`Embedded ${inserted}/${chunks.length} chunks for clinic ${clinicId}`);
    return { chunks_total: chunks.length, chunks_embedded: inserted };
  }

  // ── Express handler for POST /api/embed-clinic
  function createEmbedHandler({ ADMIN_SECRET }) {
    return async (req, res) => {
      // ── Auth check
      const authHeader = req.headers.authorization || "";
      if (!ADMIN_SECRET || authHeader !== `Bearer ${ADMIN_SECRET}`) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { phone_number_id, text, clinic_summary } = req.body;
      if (!phone_number_id) {
        return res.status(400).json({ error: "Missing phone_number_id" });
      }
      if (!text) {
        return res.status(400).json({ error: "Missing text to embed" });
      }

      try {
        // Verify clinic exists
        const result = await pool.query(
          "SELECT clinic_name_ar FROM clinics WHERE phone_number_id = $1",
          [phone_number_id]
        );
        if (result.rows.length === 0) {
          return res.status(404).json({ error: "Clinic not found" });
        }

        const stats = await chunkAndEmbed(phone_number_id, text, clinic_summary);

        console.log(`Embed complete for ${result.rows[0].clinic_name_ar}: ${stats.chunks_embedded} chunks`);
        return res.status(200).json({
          status: "embedded",
          clinic_name: result.rows[0].clinic_name_ar,
          ...stats,
        });

      } catch (err) {
        console.error("Embed error:", err.message);
        return res.status(500).json({ error: "Embedding failed", details: err.message });
      }
    };
  }

  return {
    getEmbedding,
    searchClinicVectors,
    chunkText,
    chunkAndEmbed,
    createEmbedHandler,
  };
}

module.exports = { createRagService };
