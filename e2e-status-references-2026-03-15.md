# E2E Testing Status Update — Source References
**Date:** March 15, 2026
**Purpose:** Traceability of every data point in the E2E status email back to its original source.

---

## Data Sources Used

| # | Source | Type | Access Method |
|---|--------|------|---------------|
| 1 | Google Sheet — "E2E Q1 Bundle Test Data for E2E" | Spreadsheet | Chrome browser automation (screenshots + keyboard navigation) |
| 2 | Google Sheet — "Q1 Bundle E2E planning" | Spreadsheet | Chrome browser automation (screenshots + keyboard navigation) |
| 3 | Google Chat — "E2E for Q1 Bundles" space | Chat messages | Google Chat REST API via PowerShell (`Invoke-RestMethod`) using OAuth token refresh |
| 4 | Google Chat — "E2E Bug Triage - Authority Bundles" space | Chat messages | Google Chat REST API via PowerShell |
| 5 | Azure DevOps (ADO) — Authority Bundle E2E Dashboard | Bug tracker | Chrome browser automation (screenshot of dashboard) |
| 6 | YouTrack — E2E Issue Tracking Dashboard | Bug tracker | Chrome browser automation (screenshot + `get_page_text`) |
| 7 | Airtable — Q1 Bundle Status Reports | Project management | Airtable MCP connector (`list_records_for_table`) |

---

## Section-by-Section References

### Overall Status Summary (test case counts)

| Data Point | Source | Detail |
|-----------|--------|--------|
| 23 total test cases (FL_TC01–TC23) | **Source 1** — Google Sheet `1hXm2esH2gHvUHOrXDpGgg0rcy4Uomad5PX5bl3E8Hz0`, tab "E2E Test Data FL SF" | Columns: TC#, Scenario, Final Status, Priority |
| Round 4 of testing | **Source 1** — Same sheet, "Round-4" column visible in headers | |
| FL_TC01–TC05: Hold, 03/05/2026 | **Source 1** — Rows for TC01–TC05, Final Status = "Hold", Tested date = 03/05/2026, QA Notes = "Fill all mandatory fields on Quote, & Review and Submit order" |
| FL_TC06–TC10: Hold, 3/6/2026 | **Source 1** — Rows for TC06–TC10, Final Status = "Hold", Tested date = 3/6/2026, QA Notes = "Ready to add products" |
| FL_TC11: Retest, 3/9/2026 | **Source 1** — Final Status = "Retest", QA Notes = "Quote Stage Updated to Proposal / MAC: Q1 Bundle Product Order Processing case created" |
| FL_TC12: Retest, 3/9/2026 | **Source 1** — Same as TC11 |
| FL_TC13: In Progress, 3/9/2026 | **Source 1** — QA Notes = "ACH | Recurly | Sync Billing | Files attached | FL Q1 Bundle" |
| FL_TC14: E2E PASS, 3/9/2026 | **Source 1** — Final Status = "E2E PASS" |
| FL_TC15: Hold, 3/10/2026 | **Source 1** — Repeat TC13 scenario |
| FL_TC16: E2E PASS, 3/10/2026 | **Source 1** — Final Status = "E2E PASS" |
| FL_TC17: Pass, 3/10/2026 | **Source 1** — Final Status = "Pass" |
| FL_TC21: E2E PASS, 3/11/2026 | **Source 1** — Final Status = "E2E PASS" |
| FL_TC22: Not Started | **Source 1** — Final Status = "Not Started" |
| FL_TC23: Not Started | **Source 1** — Final Status = "Not Started" |
| "PER TREY, Q1 BUNDLES CAN ONLY BE SOLD TO EXISTING CUSTOMERS in FINDLAW SALESFORCE" | **Source 1** — Header note at top of sheet |

### What's Working

| Data Point | Source | Detail |
|-----------|--------|--------|
| FL_TC14, TC16, TC17, TC21 pass details | **Source 1** — Test case statuses from E2E Test Data sheet |
| Sale → Matching Tool → COB → Pass to MAC SF → Account Setup workflow | **Source 2** — Google Sheet `1olaIQUOuIqKYoJOOAlPyA4xbPxKG2u3_mA8gtv4Yv0A`, "Owners" tab showing workflow steps and owners: Praveen (SF Sale), Mikalai (Matching Tool), Bharghavi (FL/COB), Nama (MAC SF Sale) |

### Where We're Stuck

| Data Point | Source | Detail |
|-----------|--------|--------|
| FL_TC01–TC10 blocked details | **Source 1** — QA Notes for respective test cases |
| FL_TC11/TC12 retest needed | **Source 1** — Final Status = "Retest" |
| FL_TC13/TC15 in progress/hold | **Source 1** — Final Status column |
| Org ID and Avvo Professional IDs not populated for Q-00431601/WLD 4959385 | **Source 3** — Google Chat "E2E for Q1 Bundles" space, message from Bharghavi Suresh (users/103827480372031037955), 2026-03-13T18:05:53Z: "For this Quote. - Q-00431601- for the WLD ID 4959385, Org ID and Avvo professional IDs are not populated" |
| KC Levesque asking about Avvo PID mapping | **Source 3** — Message from KC (users/103701243529666401399), 2026-03-13T20:28:54Z: "@Trey Moore/@Trevor Hawkins - do you know where the mapping is done for Avvo PID?" |
| Avvo PID 1843520 identified | **Source 3** — Message from Jesus Madrigal (users/113309954991773899178), 2026-03-13T20:02:16Z: "WLD ID: 4959385 corresponds to Avvo PID: 1843520" |
| Trevor Hawkins: all matching via Profile Match tool | **Source 3** — Message from Trevor (users/118223275503769907928), 2026-03-13T19:28:49Z: "All matching are done via the Profile Match tool in PU" |
| UUID e9f99287-f640-4b28-8af0-fd99600cb57e matched | **Source 3** — Message from Trevor (users/118223275503769907928), 2026-03-13T17:38:35Z: "I matched 4959385 to UUID e9f99287-f640-4b28-8af0-fd99600cb57e" |
| Ngage setup info sent to Kendra Downing | **Source 3** — Message from Jesus Madrigal (users/113309954991773899178), 2026-03-13T19:16:27Z: listing all WLD IDs, CIDs, and Avvo staging profiles sent to Kendra |
| ADO #247908 — Wrike order validation blocking E2E | **Source 3** — Message from Justin Karch (users/111882214235863905385), 2026-03-13T20:11:53Z: "Ticket link: https://dev.azure.com/Findlaw/FindLawADO/_workitems/edit/247908 Order validation tasks for Q1 bundles not created in Wrike yes, blocking E2E testing" |
| Also confirmed in **Source 4** — E2E Bug Triage space, 2026-03-13T20:12:59Z |

### Active Risks & Blockers

#### [FindLaw] E2E Blockers — ADO Dashboard (Section 1)

| Data Point | Source | Detail |
|-----------|--------|--------|
| Tags Placeholder #3 (McNitt, New) | **Source 5** — ADO Authority Bundle E2E Dashboard, screenshot of "E2E-Blockers" swim lane, URL: `https://dev.azure.com/Findlaw/FindLawADO/_dashboards/dashboard/cba0b172-00b1-4700-9862-42016e6a5580` |
| ADO #247908: Order validation tasks (Hougard, Ready) | **Source 5** — Same dashboard, E2E-Blockers lane |
| "26.3.2 releases Sunday" timeline | **Source 3** — E2E Bug Triage space, 2026-03-13T20:15:07Z: "3.2 releases this sunday, so i doubt that's going to be possible" |

#### [FindLaw] Critical for MVP — ADO Dashboard (Section 2)

| Data Point | Source | Detail |
|-----------|--------|--------|
| All 13 items listed | **Source 5** — ADO Authority Bundle E2E Dashboard, screenshot of "Critical for MVP" swim lane. Items include: Categorize all reviews Prod (Shea), Update Bundle toggles (Belski), Fix RRAdmin/admin category UI (Shea), etc. |

#### [MAC] E2E Blockers — YouTrack (Section 3)

| Data Point | Source | Detail |
|-----------|--------|--------|
| MHLDCD-16281: LDC & MDC Non-prod pulling FL Prod Launch script | **Source 6** — YouTrack E2E Issue Tracking Dashboard, URL: `https://youtrack.internetbrands.com/dashboard?id=527-4556`, "Critical for MVP" widget. State: Deployed to Staging, Assignee: Daniel Paschal |
| MDCD-11235: MDC add new property to fldatalayer | **Source 6** — Same dashboard. State: Deployed to Staging, Assignee: Sebastian Mercado |
| LDCD-16207: LDC add new property to fldatalayer | **Source 6** — Same dashboard. State: Deployed to Staging, Assignee: Sebastian Mercado |

#### [MAC] Critical for MVP — YouTrack (Section 4)

| Data Point | Source | Detail |
|-----------|--------|--------|
| MAC-1968: UAT Feedback | **Source 6** — YouTrack dashboard. Type: Fulfillment, State: Open, Assignee: Sai Vihari Ravulapati |
| LDCD-16246: SPIKE check if zip code being passed | **Source 6** — State: Deployed to Production, Assignee: Sebastian Mercado |
| CSMR-15953: adobeVisitorId missing | **Source 6** — State: Deployed to Production, Assignee: Andres Canales |
| MDCD-11237: FormUrl missing from MDC contact form | **Source 6** — State: Approved on Staging, Priority: Showstopper, Assignee: Gegham Movses |
| CSMR-15959: Invoca Double-Hop Insight Verification | **Source 6** — State: Open, Assignee: Unassigned |
| LDCD-16188: Adobe Beacons not firing | **Source 6** — State: Approved on Staging, Assignee: Gegham Movses |

#### [MAC] E2E Bug Triage — Resolved (Section 5)

| Data Point | Source | Detail |
|-----------|--------|--------|
| AJ-11594 resolved, re-tested, closed 3/13 | **Source 4** — E2E Bug Triage space, 2026-03-13T23:25:13Z: "https://youtrack.internetbrands.com/issue/AJ-11594 ----Resolved, Re-tested and closed." |
| AJ-11595 resolved, re-tested, closed 3/13 | **Source 4** — E2E Bug Triage space, 2026-03-13T23:48:16Z: "https://youtrack.internetbrands.com/issue/AJ-11595 ---Resolved, Re-tested and closed." |
| Both reported as Avvo AJ-side bugs | **Source 4** — 2026-03-13T21:43:02Z: "Avvo AJ side bug tickets: https://youtrack.internetbrands.com/issue/AJ-11594 https://youtrack.internetbrands.com/issue/AJ-11595" |
| Not blocking E2E | **Source 4** — 2026-03-13T22:45:36Z and 22:45:52Z: "No" (in response to "is this blocking continuing E2E testing?") |
| Also in **Source 7** — Airtable base `appq6NWOEqbz4eRN9`, Status Reports table (`tblRNAKuSGEdCtBMb`), record for "[MAC] Q1 Bundle Fulfillment" dated 3/13: "E2E bugs AJ-11595, AJ-11594 found and resolved same day" |

#### [FindLaw] Firm Name Encoding Issue (Section 6)

| Data Point | Source | Detail |
|-----------|--------|--------|
| Law firm name mismatch in provisioning email | **Source 3** — Bharghavi (users/103827480372031037955), 2026-03-13T18:12:21Z: "Also the law firm name in the provisioning email does not match the field in the chat tab for some profiles" |
| Special character encoding issue (& symbol) | **Source 3** — Doug Heger (users/111978725074599642790), 2026-03-13T20:44:50Z: "it looks like the firm name has & in it with what was in the email was text before & and nothing after, so maybe some encoding / special character issue" |
| ADO #247907 created | **Source 3** — Bharghavi (users/103827480372031037955), 2026-03-13T20:00:11Z: "I created one under order fulfillment board. https://dev.azure.com/Findlaw/FindLawADO/_workitems/edit/247907" |

### Key Activity This Week

| Data Point | Source | Detail |
|-----------|--------|--------|
| Final 4 accounts: FL_TC14 & FL_TC21 (FL SF), FL_TC19 & FL_TC20 (MAC SF) | **Source 3** — Praveen Yadagude (users/106461875867101229941), 2026-03-12T20:41:35Z: "Final 4 Accounts for E2E from Findlaw Salesforce... FL_TC14 & FL_TC21 -> FindLaw SF Initiated Sales orders... FL_TC19 & FL_TC20 -> MAC SF Initiated Sales orders" |
| All 4 rows loaded to Tracker DB | **Source 3** — KC Levesque (users/103701243529666401399), 2026-03-13T15:07:09Z: "I can confirm that all 4 rows (FL_TC14, FL_TC19, FL_TC20 and FL_TC21) from 'Account Setup FL SF' tab... successfully loaded to Tracker DB" |
| ProVantage cancellation for FL_TC19 | **Source 3** — Trey Moore (users/107898714515847205797), 2026-03-13T20:07:57Z: "@Namachivayam Mohan Can you initiate cancelation of ProVantage from MAC SF for following account: WLD ID: 4959385 (FL_TC19)" |
| Nama confirmed done | **Source 3** — Namachivayam Mohan (users/115445720276362167974), 2026-03-13T20:17:53Z: "Done" |
| Profile Redesign Rollout GO for 3/15 | **Source 7** — Airtable Status Reports, record for "[FindLaw] Profile redesign rollout" dated 3/11: "GO for release on 3/15 as 26.3.2" |
| Accelerator & Essential FL Profile Types complete | **Source 7** — Airtable Status Reports, record for "[FindLaw] Accelerator & Essential FL Profile Types" dated 3/11: "Complete, deployed but toggled off" |
| Cross-Network Badging last story done | **Source 7** — Airtable Status Reports, record for "[FindLaw] Cross-Network Badging" dated 3/11: "Last story completed, planned for 26.3.2" |
| Attorney Listings on FL SRPs: 9 stories + 4 bugs | **Source 7** — Airtable Status Reports, record for "[FindLaw] Attorney listings on FL SRPs" dated 3/11: "Down to 9 stories + 4 bugs" |
| Dynamic AI Intake Form: end date updated | **Source 7** — Airtable Status Reports, record for "[FindLaw] Dynamic AI Intake Form on Firmsites" dated 3/15: "End date updated for 26.3.2; disclaimer work larger than anticipated" |
| Invoca Double-Hop: PIDs set up on Avvo Staging | **Source 3** — User (users/115423042428538676652), 2026-03-13T00:34:32Z: "Avvo Invoca Status Update: Test run start pending new changes for MAC transactions/traffic going up to Avvo Staging Enviro. But the PIDs setup for invoca on Avvo Staging: 1199854, 4479076" |

### Next Steps

| Data Point | Source | Detail |
|-----------|--------|--------|
| "FL feature testing for E2E should be able to start Monday morning" | **Source 3** — Trey Moore (users/109853359089343006383), 2026-03-14T00:47:40Z (Friday 5:47 PM PT) |
| ADO #247908 needs resolution | **Source 3** + **Source 5** — Cross-referenced from chat (Justin Karch) and ADO dashboard |
| MAC E2E blockers need production deployment | **Source 6** — YouTrack dashboard: MHLDCD-16281, MDCD-11235, LDCD-16207 all showing "Deployed to Staging" |
| MDCD-11237 showstopper | **Source 6** — YouTrack dashboard, Priority: Showstopper |
| CSMR-15959 unassigned | **Source 6** — YouTrack dashboard, Assignee: Unassigned |
| Ngage setup with Kendra Downing | **Source 3** — Multiple messages from Jesus Madrigal and KC Levesque on 3/13 referencing Kendra |
| FL_TC11 & FL_TC12 retest | **Source 1** — Final Status = "Retest" |
| FL_TC22 & FL_TC23 not started | **Source 1** — Final Status = "Not Started" |

---

## Source URLs

| Source | URL / Identifier |
|--------|-----------------|
| Google Sheet 1 (E2E Test Data) | `https://docs.google.com/spreadsheets/d/1hXm2esH2gHvUHOrXDpGgg0rcy4Uomad5PX5bl3E8Hz0` |
| Google Sheet 2 (E2E Planning) | `https://docs.google.com/spreadsheets/d/1olaIQUOuIqKYoJOOAlPyA4xbPxKG2u3_mA8gtv4Yv0A` |
| Google Chat — E2E for Q1 Bundles | Space ID: `spaces/AAQAve0AYtw` |
| Google Chat — E2E Bug Triage | Space ID: `spaces/AAQAdT8Zju4` |
| ADO Dashboard | `https://dev.azure.com/Findlaw/FindLawADO/_dashboards/dashboard/cba0b172-00b1-4700-9862-42016e6a5580` |
| YouTrack Dashboard | `https://youtrack.internetbrands.com/dashboard?id=527-4556` |
| Airtable Base | Base ID: `appq6NWOEqbz4eRN9`, Projects table: `tblXoVF2kUYL5tFd`, Status Reports table: `tblRNAKuSGEdCtBMb` |

---

## Google Chat User ID → Name Mapping
_(Identified from message context and @-mentions)_

| User ID | Name |
|---------|------|
| users/109853359089343006383 | Trey Moore |
| users/118223275503769907928 | Trevor Hawkins |
| users/103701243529666401399 | Kheuamalai "KC" Levesque |
| users/111856285839237131231 | Nazmul Hussain |
| users/111978725074599642790 | Doug Heger |
| users/103827480372031037955 | Bharghavi Suresh |
| users/111882214235863905385 | Justin Karch |
| users/107898714515847205797 | Trey Moore (alt) / Romit Nath |
| users/106461875867101229941 | Praveen Yadagude |
| users/115445720276362167974 | Namachivayam Mohan |
| users/113309954991773899178 | Jesus Madrigal |
| users/106018856898886815182 | Surya Rao |
| users/114087816020558687992 | (Unknown — confirmed LawInfo profile context) |
| users/115423042428538676652 | (Avvo Invoca status poster — likely Invoca team) |
| users/103827480372031037955 | Bharghavi Suresh |

---

*Generated March 15, 2026 for eval/audit traceability.*
