# Claude Code Prompts for Google Chat Summarization
# ==================================================
# 
# SETUP (run once):
#   1. Place oauth_credentials.json and gchat_pull.py in your working directory
#   2. pip install google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client
#   3. First run will open a browser for Google auth — approve it
#
# Copy-paste any of the prompts below into Claude Code.
# Replace the space ID / dates / topic as needed.
#
# Your known space ID: spaces/AAAAzX5oJWU
# ==================================================


# ---- PROMPT 1: List all your Google Chat spaces ----

"""
Run `python gchat_pull.py --list-spaces` and show me all the spaces I'm in. 
Format the results as a table with space name, type, and display name.
"""


# ---- PROMPT 2: Pull and summarize a specific chat space ----

"""
Run this command to pull Google Chat messages:

python gchat_pull.py --space "spaces/AAAAzX5oJWU" --after "2025-03-01" --before "2025-03-15" --output chat_dump.txt

Then read chat_dump.txt and give me:
1. A concise executive summary of what was discussed (3-5 sentences)
2. Key decisions made
3. Action items with owners if mentioned
4. Open questions or blockers
5. Topics that need follow-up

Keep the summary direct and factual. No filler.
"""


# ---- PROMPT 3: Pull chat and summarize by topic/workstream ----

"""
Run this command to pull Google Chat messages:

python gchat_pull.py --space "spaces/AAAAzX5oJWU" --after "2025-03-01" --before "2025-03-15" --output chat_dump.txt

Then read chat_dump.txt and organize the summary by workstream/topic. 
Group related discussions together. For each topic:
- What was discussed
- Current status
- Who's involved
- Any blockers or decisions needed

Focus on project-relevant content — skip small talk and acknowledgments.
"""


# ---- PROMPT 4: Pull chat and find action items only ----

"""
Run this command:

python gchat_pull.py --space "spaces/AAAAzX5oJWU" --after "2025-03-10" --output chat_dump.txt

Read chat_dump.txt and extract ONLY:
- Action items (who needs to do what, by when if mentioned)
- Commitments made by team members
- Deadlines or dates mentioned
- Decisions that were finalized

Format as a table: Owner | Action Item | Due Date | Context
"""


# ---- PROMPT 5: Pull from multiple spaces and cross-reference ----

"""
Pull messages from these spaces for the last 7 days:

python gchat_pull.py --space "spaces/SPACE_ID_1" --after "2025-03-08" --output chat_space1.txt
python gchat_pull.py --space "spaces/SPACE_ID_2" --after "2025-03-08" --output chat_space2.txt

Read both files and:
1. Identify topics discussed across both spaces
2. Flag any conflicting information or decisions
3. Summarize the overall status of cross-cutting initiatives
4. Note anything from one space that the other space should know about
"""


# ---- PROMPT 6: Weekly status report from chat ----

"""
Run:
python gchat_pull.py --space "spaces/AAAAzX5oJWU" --after "2025-03-08" --before "2025-03-15" --output week_chat.txt

Read week_chat.txt and draft a weekly status update email covering:
- Accomplishments this week (what got done)
- In progress (what's actively being worked on)
- Blockers / risks
- Key decisions made
- Next week's priorities (based on what was discussed)

Write it in plain language suitable for executive stakeholders. Keep it under 300 words.
"""


# ---- PROMPT 7: Targeted topic search ----

"""
Run:
python gchat_pull.py --space "spaces/AAAAzX5oJWU" --after "2025-03-01" --output chat_dump.txt

Read chat_dump.txt and find ALL messages related to [TOPIC - e.g., "Invoca", "RAS", "production release"]. 
Summarize:
- Timeline of the discussion
- Current status
- Who's driving it
- What's been decided vs. still open
"""
