# New Client Onboarding Checklist

> Time: ~15 minutes per client
> Prerequisites: Neon database access, Google Calendar (sellora.ai.ai@gmail.com), 360dialog dashboard (when ready)

---

## Step 1: Create Google Calendars (5 min)

1. Go to https://calendar.google.com (logged in as sellora.ai.ai@gmail.com)
2. Create a new calendar: "[Clinic Name] — Appointments"
   - Note the Calendar ID (Settings → Integrate calendar → Calendar ID)
3. Create another calendar: "[Clinic Name] — Working Hours"
   - Add recurring events for the clinic's working days/hours (e.g., "Open" Mon-Sat 9AM-6PM)
   - Note the Calendar ID
4. Share both calendars with the clinic owner's email (View access so they can see bookings)

**Save these two Calendar IDs — you need them in Step 2.**

---

## Step 2: Add to Database (3 min)

Go to Neon dashboard → SQL Editor → run this INSERT (replace ALL values):

```sql
INSERT INTO clinics (
  phone_number_id, clinic_name_ar, clinic_name_en, location, doctors,
  appointments_cal_id, working_hours_cal_id, timezone, notification_phone,
  languages, use_rag, knowledge_base, active
) VALUES (
  'META_PHONE_NUMBER_ID_HERE',
  'اسم العيادة بالعربي',
  'Clinic Name in English',
  'العنوان بالعربي',
  'د. [اسم] ([تخصص])، د. [اسم] ([تخصص])',
  'APPOINTMENTS_CALENDAR_ID_HERE',
  'WORKING_HOURS_CALENDAR_ID_HERE',
  'Asia/Riyadh',
  'OWNER_WHATSAPP_NUMBER_WITH_COUNTRY_CODE',
  'ar,en,fr',
  FALSE,
  'الخدمات والأسعار:
[service 1]: [price]
[service 2]: [price]
...',
  TRUE
);
```

### Field Reference:
| Field | Example | Notes |
|-------|---------|-------|
| phone_number_id | '967413439796424' | From Meta/360dialog — the WhatsApp number ID |
| clinic_name_ar | 'عيادة الرياض لطب الأسنان' | Arabic name Sara uses in conversation |
| clinic_name_en | 'Riyadh Dental Clinic' | English name for logs |
| location | 'حي العليا، الرياض، مبنى 5' | Arabic address |
| doctors | 'د. محمد (زراعة)، د. سارة (تقويم)' | Arabic, comma-separated |
| appointments_cal_id | 'abc123@group.calendar.google.com' | From Step 1 |
| working_hours_cal_id | 'def456@group.calendar.google.com' | From Step 1 |
| timezone | 'Asia/Riyadh' or 'Asia/Dubai' | Client's timezone |
| notification_phone | '966501234567' | With country code, no + |
| languages | 'ar,en' or 'ar,en,fr' | Comma-separated |
| use_rag | FALSE | TRUE only for enterprise tier |
| knowledge_base | Full services + prices in Arabic | Under 50,000 characters |
| active | TRUE | Set FALSE to disable |

---

## Step 3: Add WhatsApp Number (5 min)

### Current setup (Meta direct — first client only):
- Already configured, no action needed

### Future setup (360dialog — 2nd+ clients):
1. Go to 360dialog dashboard
2. Add new WhatsApp number
3. Note the phone_number_id assigned
4. Use this ID in the database INSERT above

---

## Step 4: Test (2 min)

1. Send "سلام" to the clinic's WhatsApp number from a test phone
2. Sara should greet with the correct clinic name
3. Ask about a service price — verify it matches the database
4. Book a test appointment — verify it appears on the correct Google Calendar
5. Cancel the test appointment

**If all 4 pass → invoice the client.**

---

## Quick Admin Tasks

### Change a price or service:
```sql
UPDATE clinics SET knowledge_base = 'new services and prices text here'
WHERE phone_number_id = 'THE_PHONE_NUMBER_ID';
```

### Disable a client:
```sql
UPDATE clinics SET active = FALSE
WHERE phone_number_id = 'THE_PHONE_NUMBER_ID';
```

### Add urgent update (priority override):
```sql
UPDATE clinics SET priority_override = 'Dr. Ahmed is on vacation until April 10. Only Dr. Fatima is available.'
WHERE phone_number_id = 'THE_PHONE_NUMBER_ID';
```

### Clear priority override:
```sql
UPDATE clinics SET priority_override = NULL
WHERE phone_number_id = 'THE_PHONE_NUMBER_ID';
```

---

## What Does NOT Need to Change Per Client

- Railway (server-v2.js) — same instance for all clients
- Make.com scenarios — same 2 scenarios for all clients
- Sara's base prompt (sara_prompt_base.txt) — universal rules
- Redis (Upstash) — shared conversation storage
- No code changes. No redeployment. No configuration files.
