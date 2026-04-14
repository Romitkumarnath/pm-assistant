# LGLMAC-206 Project Status Report
### [email-services] Differentiate LDC and MDC Site-Level Lead Attribution

---

## 📋 Ticket Overview

| Field | Detail |
|---|---|
| **Ticket** | LGLMAC-206 |
| **Type** | Story |
| **State** | More Info Required |
| **Assignee** | Emmanuel Akachukwu |
| **Story Points** | 5 |
| **Dev Resources** | Emmanuel Akachukwu |
| **Related Tickets** | PRDD-1119, DSARC-2847 (Closed ✅), LEGRA-699 (Deployed to Production ✅) |
| **Parent Epic** | PRDD-1119 – Site-level attribution for LDC&MDC leads |

---

## ✅ 1. What's Accomplished

### Email Lead Attribution
- **Emmanuel Akachukwu** successfully attributed email leads via the **email-services payload** being sent to **LeadsExtranet**. LDC/MDC source values are now being appended to the request parameters flowing to downstream platforms.
- Confirmed via `leads.email_lead.source` field, which already contains `LDC` and `MDC` values (data verified by **Andrew Bergamasco** on staging: ~94K LDC and ~33K MDC records since Jan 1, 2024).

### Database Schema Change — DSARC-2847 ✅ Closed
- A `call_source` column (originally proposed as `source`) was added to the `leads.call_lead` table on both staging and production (`ibmhpgdb1.internetbrands.com`).
- **Kristine Kaneko** reviewed, approved, and executed the DDL (`ALTER TABLE leads.call_lead ADD COLUMN source VARCHAR(100)`), renamed to `call_source` per her feedback to avoid using a reserved keyword.
- This unblocked the ability to store call lead source attribution in the MH database.

### LEGRA-699 — Deployed to Production ✅
- **LEGRA-699** ("Send new source field to mh.call_leads table in store lead cron") has been **deployed to production by the DNPS team**.
- As a result, within the `mh-lead-attribution` environment, the `call_source` column is now being populated for incoming leads.
- Lead source values for both **email and call leads** are now being included in the payload sent to the **Leads Extranet API**.

### Technical Architecture Clarified
- **Andrew Bergamasco** thoroughly mapped out two separate attribution paths for phone call leads:
  - **Marchex/Telmetrics CTNs:** Join `leads.call_lead.telmetrics_study_id` → `ctn.study_details.id` → `ctn.study_details.site_id` to retrieve `LDC` or `MDC`. This works for Provantage and Authority Bundle profiles. Legacy profiles will return `null` for `site_id` — **attribution not possible for these.**
  - **DNPS-Twilio CTNs:** More complex. Cross-database join to DNPS database is not advised at scale. Three options were evaluated; the agreed approach (per Emmanuel) is to **scrape the DNPS database on a regular basis** to build a `dnps_call_id → ctn_id → domain` mapping stored in the Martindale database, leveraging the existing DNPS cron sync mechanism.
- **Nancy Ho** provided a product code mapping table (11 product codes) for LDC/MDC advertisement products (e.g., Lawyers.com Preferred County Results – `01667`, Martindale.com Preferred State Results – `01928`) to assist with attribution mapping.

### Stakeholder Alignment
- **Brian Veeder** confirmed awareness and flagged that upon completion, support will be needed to help the **EDW data team** consume site-level attribution for **LGE** (Legal Group Enterprises), in addition to Leads Extranet/MyMA use.
- **Olga Barrocas** added a specific EDW storage requirement from the LGE team: attribution data must be stored in the **same table the LGE Data team currently pulls from** (details still TBD from the data team).

---

## 🔜 2. What's Coming Up

### Immediate — Awaiting Nolo/LeadsExtranet Confirmation
- **Critical blocker:** A test conducted with **Arturo (Nolo LeadsExtranet team) on Friday, April 11** confirmed that **leads are NOT being received on the Nolo side**. Emmanuel is actively debugging this issue and planned to circle back with Arturo later on April 13 for another round of tests.
- Emmanuel is waiting on a reply from the Nolo LeadsExtranet team to confirm:
  1. Their parameter structure
  2. Whether the newly appended request param is being forwarded to downstream platforms like MyMA

### QA & Testing
- Once the Nolo confirmation issue is resolved, this ticket is expected to move to **QA/Testing**.
- Per the April 13 chat update, the estimated effort for **lead attribution (completion + QA) is 1 sprint**.
- **Revised target release date: April 23, 2026** (updated by the team on April 13).

### EDW Data Inventory (PRDD-1119 dependency)
- **Olga Barrocas** has asked **Nazmul Marathe, Moises Linares, and Abhijit Marathe** to provide an inventory of existing data tables and their current usage.
- Once validated, the team will confirm: (a) where attribution data should live in **EDW for the LGE use case**, and (b) how it flows into **Leads Extranet for MyMA**.
- **Nancy Ho** echoed this in PRDD-1119 comments, noting scope of work (LGE only vs. MyMA site-level attribution) is still being finalized.

### DNPS Domain Mapping Solution
- Emmanuel plans to engage the **DNPS team** to implement the regular scrape/sync approach for mapping `DNPS call_id → domain` into the Martindale database.

### Downstream — Leads Extranet Front-End Work
- Per **Brian Veeder's** comment on PRDD-1119, once attribution data is in LeadsExtranet, the **LE front-end team** will need to:
  - Detect whether the downloading user is an **internal user (AM)** or a **customer**.
  - For internal users: include a new site-level attribution column (LDC/MDC) in the CSV download.
  - For customers: keep the CSV unchanged (no LDC/MDC differentiation shown).

---

## ⚠️ 3. Risks

### 🔴 HIGH — Leads Not Being Received by Nolo/LeadsExtranet
- **Risk:** The April 11 test with Arturo confirmed attribution data is **not reaching the Nolo LeadsExtranet endpoint**, despite LEGRA-699 being deployed to production. The root cause is unknown.
- **Impact:** Blocks QA, testing sign-off, and the April 23 release target.
- **Owner:** Emmanuel Akachukwu (actively debugging as of April 13).
- **Mitigation:** Emmanuel is actively debugging; follow-up test with Arturo planned. No ETA confirmed yet.

### 🔴 HIGH — DNPS-Twilio Call Lead Attribution Not Yet Solved
- **Risk:** For `call_service = 'DNPS-TWILIO'` leads, there is **no implemented solution yet** to retrieve domain/source attribution. The cross-database join approach is explicitly ruled out for large datasets. The scrape/sync approach is proposed but not yet designed or built.
- **Impact:** A significant volume of call leads may remain unattributed at launch, reducing the completeness and business value of the attribution feature.
- **Owner:** Emmanuel Akachukwu (pending DNPS team engagement).
- **Mitigation:** Engage DNPS team to leverage existing cron infrastructure for syncing mapping data.

### 🟡 MEDIUM — Legacy Profile Call Leads Cannot Be Attributed
- **Risk:** For **Legacy Profile products**, `ctn.study_details.site_id` is `null`, making it impossible to determine LDC vs. MDC for Marchex/Telmetrics call leads from this segment.
- **Impact:** Partial attribution coverage; attribution will work for Provantage and Authority Bundle profiles only via Marchex CTN path.
- **Owner:** Andrew Bergamasco / Emmanuel Akachukwu.
- **Mitigation:** No current mitigation identified. This appears to be an accepted limitation. Should be explicitly documented in acceptance criteria.

### 🟡 MEDIUM — EDW Storage Requirements Undefined
- **Risk:** The LGE team requires attribution data to be stored in a **specific existing EDW table**, but the data team (**Nazmul Marathe, Moises Linares, Abhijit Marathe**) has not yet delivered the data/table inventory requested by **Olga Barrocas**.
- **Impact:** Could require rework of the storage layer if the chosen table/schema doesn't align with LGE's existing ETL processes. Blocks the Tableau reporting requirement for the LGE team.
- **Owner:** Olga Barrocas (awaiting data team response); Nancy Ho tracking on PRDD-1119.
- **Mitigation:** Olga has formally requested the inventory. Escalation may be needed if no response is provided promptly.

### 🟡 MEDIUM — Scope Creep / Multi-Team Dependency Risk
- **Risk:** This ticket has grown to involve: MAC-Service (email-services), DNPS team, Nolo/LeadsExtranet team, EDW/data team, LGE team, and potentially the Leads Extranet front-end (Sergo) team. Coordination across 5+ teams increases schedule risk.
- **Impact:** Any one team's delay (e.g., DNPS engagement, EDW inventory, LE front-end) could push the April 23 release.
- **Owner:** PM (**Ebinehita Ihayere**, currently out sick as of April 13).
- **Mitigation:** Romit has advised wrapping up the 3 in-progress projects (Signoz, Consumer Survey, Lead Attribution) before starting LGLMAC-246 (Firm/Attorney Matching). PM coverage needed urgently given Nehita's hospitalization.

### 🟡 MEDIUM — PM Availability
- **Risk:** **Ebinehita Ihayere** (PM) was hospitalized as of April 13 and was unable to attend the team meeting, requesting estimation updates from the team.
- **Impact:** Risk to coordination, release checklist management, and stakeholder communication during a critical debug/QA phase.
- **Mitigation:** Team members self-organized on April 13 to provide estimates. Release dates were updated by another team member. Formal PM backup should be confirmed.

### 🟢 LOW — Historical Data Attribution
- **Risk:** PRDD-1119 explicitly calls out the need to attribute **historical data**, but no plan for backfilling `call_source` values for existing records has been discussed or scoped.
- **Impact:** LGE Tableau reports may show incomplete attribution for historical leads, limiting the business insight value.
- **Owner:** Not yet assigned.
- **Mitigation:** Needs to be added to discovery scope. The `call_source` column is nullable so no immediate data integrity risk.

---

## 📅 Summary Timeline

| Milestone | Status | Target Date |
|---|---|---|
| DSARC-2847 – `call_source` column added | ✅ Done | Completed |
| LEGRA-699 – Source field sent to `mh.call_leads` | ✅ Deployed to Production | Completed |
| Email lead attribution via email-services payload | ✅ Done | Completed |
| Debug: Leads not received by Nolo LeadsExtranet | 🔴 In Progress | ASAP |
| EDW data/table inventory from data team | 🟡 Pending | TBD |
| DNPS-Twilio domain mapping solution | 🟡 Pending | TBD |
| QA & Testing | ⏳ Not Started | ~April 20–23 |
| **Production Release** | ⏳ Pending | **April 23, 2026** |