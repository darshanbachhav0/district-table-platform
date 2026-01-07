# District Table Platform (Admin + District portals)

A simple role-based web app where:
- **Admin** can create/edit templates (tables/forms), manage columns/fields, assign them to districts, and view all submissions.
- **District users** can **only fill their own assigned tables**, save drafts, and **Send** final data to admin.
- On **Send**, the backend tries to email the admin and also marks the submission as sent (visible in admin dashboard).

✅ Built with: **HTML + CSS + Vanilla JS (frontend)** + **Node.js + Express + SQLite (backend)**  
✅ Supports typing in **Marathi + English** (UTF-8 + Devanagari-friendly font fallbacks)

---

## 1) Requirements

- Node.js 18+ (works on Windows / Linux / Mac)

---

## 2) Setup

```bash
cd server
npm install
cp .env.example .env
# edit .env with your SMTP (optional) and ADMIN_EMAIL
npm run dev
```

Then open:
- http://localhost:8080  (Login)

---

## 3) Login credentials (default seed)

**Admin**
- username: `admin`
- password: `admin123`

**District users**
- username: `amravati_rural`  password: `district123`
- username: `amravati_city`   password: `district123`
- username: `buldhana`        password: `district123`
- username: `washim`          password: `district123`
- username: `yavatmal`        password: `district123`
- username: `akola`           password: `district123`

> Admin can create more district users from the Admin Portal.

---

## 4) Email sending (optional)

If you want emails to be sent on “Send”:
- Fill SMTP values in `.env`
- Example providers: Gmail App Password, Office365 SMTP, etc.

If SMTP is not configured, the app will still work; it will just **log** an email preview on the server console.

---

## 5) How to use

### Admin workflow
1. Login as admin → opens **Admin Portal**
2. Create a **Template** (table/form)
3. Add fields/columns (labels can be Marathi/English)
4. Publish template
5. Assign it to districts
6. Watch submissions in “Submissions” tab

### District workflow
1. Login with a district account → opens **District Portal**
2. Open assigned template
3. Fill data (Marathi/English)
4. Save draft
5. Click **Send to Admin** (locks editing)

---

## 6) Notes about Marathi font

- The UI uses UTF‑8 and a font stack that supports Devanagari:
  `Noto Sans Devanagari`, `Nirmala UI`, `Mangal`, etc.
- Even if the user’s device doesn’t have one font installed, OS fallback will show Marathi.

---

## 7) Project structure

```
district-table-platform/
  public/            # Frontend (HTML/CSS/JS)
  server/            # Backend (Node/Express/SQLite)
```

---

## 8) Production

For production, you can run:
```bash
npm start
```

and put it behind Nginx/Apache or deploy to a VPS.

---

## License
MIT
