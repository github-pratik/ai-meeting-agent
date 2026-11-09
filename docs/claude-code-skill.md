# The `/meeting` Claude Code skill (action layer)

The web page never writes to the CRM or email. Approved items are executed by an admin through a
[Claude Code](https://claude.com/claude-code) skill that uses MCP connectors the admin is already
signed in to (Zoho CRM, Microsoft 365). This keeps credentials out of the web app and keeps a human
in the loop for every write.

What the skill does, in order:

1. **Find approvals.** Scan `meetings/*/actions.json` for items with `"status": "approved"` and list them
   (task, owner, due date; invite time and attendees; email recipients).
2. **Confirm once.** "Create these 3 Zoho tasks?" Email and calendar invites are always shown in full
   before sending, because they reach other people.
3. **Resolve the target org.** Call `getOrganization` on the CRM connector first and check it is the
   production org, not the sandbox.
4. **Create.**
   - Task: `createRecords` on module `Tasks` with `Subject`, `Owner.id`, `Due_Date`, `Priority`,
     `Status: "Not Started"`, and a `Description` that quotes the meeting line and timestamp.
     Link a named student/lead/employer only when exactly one CRM record matches.
   - Email: create an Outlook draft first, send only on an explicit yes.
   - Invite: create the calendar event (this emails attendees, so confirm first).
5. **Read back** each record and write `status`, `zoho_id` / `outlook_url` and `done_at` into
   `actions.json`, so the web page shows the item as done with a link.

Gotcha found while testing: an existing CRM automation marked *every* open task on a lead as complete
whenever the lead's status changed. The skill warns before linking a meeting task to a lead, so a task
can't silently disappear from its owner's list.
