#!/usr/bin/env python3
"""
gchat_pull.py — Pull Google Chat messages and output for summarization.

Place oauth_credentials.json in the same directory as this script.

Usage:
    python gchat_pull.py --space "spaces/AAAAzX5oJWU" --after "2025-03-01" --before "2025-03-15"
    python gchat_pull.py --space "spaces/AAAAzX5oJWU" --after "2025-03-01" --output chat_dump.txt
    python gchat_pull.py --list-spaces  (to find your space IDs)
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone

from google.auth.transport.requests import Request
from googleapiclient.discovery import build

SCOPES = [
    "https://www.googleapis.com/auth/chat.messages.readonly",
    "https://www.googleapis.com/auth/chat.spaces.readonly",
]


def authenticate(credentials_file="oauth_credentials.json", token_file="token.json"):
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow

    creds = None
    if os.path.exists(token_file):
        creds = Credentials.from_authorized_user_file(token_file, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(credentials_file):
                print(f"ERROR: {credentials_file} not found in {os.getcwd()}", file=sys.stderr)
                sys.exit(1)
            flow = InstalledAppFlow.from_client_secrets_file(credentials_file, SCOPES)
            creds = flow.run_local_server(port=0)
        with open(token_file, "w") as f:
            f.write(creds.to_json())
    return creds


def list_spaces(service):
    """List all spaces the authenticated user is a member of."""
    results = service.spaces().list(pageSize=100).execute()
    spaces = results.get("spaces", [])
    if not spaces:
        print("No spaces found.")
        return
    print(f"{'Space Name':<30} {'Type':<15} {'Display Name'}")
    print("-" * 80)
    for s in spaces:
        print(f"{s.get('name', ''):<30} {s.get('type', ''):<15} {s.get('displayName', '(no name)')}")


def fetch_messages(service, space_name, after_dt=None, before_dt=None):
    all_messages = []
    page_token = None

    filter_parts = []
    if after_dt:
        filter_parts.append(f'createTime > "{after_dt.isoformat()}"')
    if before_dt:
        filter_parts.append(f'createTime < "{before_dt.isoformat()}"')
    filter_str = " AND ".join(filter_parts) if filter_parts else ""

    while True:
        kwargs = {"parent": space_name, "pageSize": 100, "orderBy": "createTime asc"}
        if filter_str:
            kwargs["filter"] = filter_str
        if page_token:
            kwargs["pageToken"] = page_token

        try:
            result = service.spaces().messages().list(**kwargs).execute()
        except Exception as e:
            print(f"API Error: {e}", file=sys.stderr)
            break

        messages = result.get("messages", [])
        all_messages.extend(messages)
        print(f"  Fetched {len(messages)} messages (total: {len(all_messages)})", file=sys.stderr)

        page_token = result.get("nextPageToken")
        if not page_token:
            break
        time.sleep(0.5)

    return all_messages


def format_for_summary(messages):
    """Format messages into a readable transcript grouped by thread."""
    # Group messages by thread
    threads = {}
    thread_order = []
    for msg in messages:
        thread_name = msg.get("thread", {}).get("name", "no_thread")
        if thread_name not in threads:
            threads[thread_name] = []
            thread_order.append(thread_name)
        threads[thread_name].append(msg)

    lines = []
    for thread_name in thread_order:
        msgs = threads[thread_name]
        if len(msgs) > 1:
            lines.append("--- Thread ---")
        for i, msg in enumerate(msgs):
            sender = msg.get("sender", {}).get("displayName", "Unknown")
            ts = msg.get("createTime", "")[:16].replace("T", " ")
            text = msg.get("text", "").strip()
            if text:
                prefix = "  ↳ " if i > 0 else ""
                lines.append(f"{prefix}[{ts}] {sender}: {text}")
        if len(msgs) > 1:
            lines.append("")
    return "\n".join(lines)


def parse_date(s):
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def main():
    parser = argparse.ArgumentParser(description="Pull Google Chat messages for summarization")
    parser.add_argument("--space", help='Space name, e.g. "spaces/AAAAzX5oJWU"')
    parser.add_argument("--after", help="Messages after this date (YYYY-MM-DD)")
    parser.add_argument("--before", help="Messages before this date (YYYY-MM-DD)")
    parser.add_argument("--output", "-o", help="Output file (default: stdout)")
    parser.add_argument("--list-spaces", action="store_true", help="List all spaces you belong to")
    parser.add_argument("--credentials", default="oauth_credentials.json")
    args = parser.parse_args()

    creds = authenticate(credentials_file=args.credentials)
    service = build("chat", "v1", credentials=creds)

    if args.list_spaces:
        list_spaces(service)
        return

    if not args.space:
        print("ERROR: --space is required (or use --list-spaces to find space IDs)", file=sys.stderr)
        sys.exit(1)

    after_dt = parse_date(args.after)
    before_dt = parse_date(args.before)

    print(f"Pulling from {args.space}...", file=sys.stderr)
    messages = fetch_messages(service, args.space, after_dt, before_dt)

    if not messages:
        print("No messages found.", file=sys.stderr)
        return

    transcript = format_for_summary(messages)
    print(f"\n{len(messages)} messages formatted for summary.\n", file=sys.stderr)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(transcript)
        print(f"Saved to {args.output}", file=sys.stderr)
    else:
        print(transcript)


if __name__ == "__main__":
    main()
