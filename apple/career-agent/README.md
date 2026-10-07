# Siri + Shortcuts career agent

"Hey Siri, log a job lead" on iPhone or Mac. The Shortcut sends what you say to the private endpoint in [`api/career-agent.js`](../../api/career-agent.js), which structures it with Claude Haiku, stores it in Upstash Redis and returns a sentence for Siri to read back.

## 1. Server setup (once)

Generate a token and add it in Vercel > Project > Settings > Environment Variables as `CAREER_AGENT_TOKEN`, then redeploy:

```bash
openssl rand -hex 32
```

`ANTHROPIC_API_KEY` and the Upstash variables are the ones the site already uses. To switch the endpoint off without a deploy: `SET killswitch:career-agent on` in the Upstash console.

## 2. Check it from the Mac

```bash
export CAREER_AGENT_TOKEN=...   # the value you set in Vercel
curl -s https://www.yashhooda.ai/api/career-agent \
  -H "Authorization: Bearer $CAREER_AGENT_TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"log_lead","text":"Talked to a recruiter at Example Co about a data engineer role, remote, follow up Friday"}'
```

## 3. Build the Shortcut "Log job lead"

In the Shortcuts app, create a shortcut with these actions in order:

1. **Dictate Text** (or **Ask for Input** with type Text if you prefer typing).
2. **Get Contents of URL**
   - URL: `https://www.yashhooda.ai/api/career-agent`
   - Method: `POST`
   - Headers: `Authorization` = `Bearer <your token>`
   - Request Body: JSON, with `action` = `log_lead` and `text` = the *Dictated Text* variable
3. **Get Dictionary Value**: key `speak` from *Contents of URL*.
4. **Speak Text** (or **Show Result**): the dictionary value.

Name it "Log job lead". Siri runs it by name, and it syncs to the Mac through iCloud.

Three more shortcuts are the same four steps with a different body:

| Shortcut | Step 1 | JSON body |
| --- | --- | --- |
| Summarize recruiter email | **Get Clipboard** (copy the email first), or receive text from the Share Sheet | `action` = `summarize_email`, `text` = clipboard, `save` = true (Boolean) |
| Update application | **Ask for Input** twice: company, then status | `action` = `update_status`, `company`, `status` |
| Job search status | none | `action` = `list` |

Statuses: `lead`, `applied`, `screen`, `interview`, `offer`, `rejected`, `withdrawn`.

## Notes

- The token sits inside the Shortcut. Do not share the Shortcut with the token filled in; rotate the token in Vercel if a device is lost.
- There is no public read path. The site does not display anything from this endpoint.
- If the model is unavailable, `log_lead` still saves your raw note with `needs_review: true`, so nothing dictated is lost.
- Email text is untrusted input. The model is asked for JSON only, and the endpoint keeps only a fixed list of string fields from its answer, so an instruction hidden in an email cannot change a status or write an arbitrary field. The summary can still be wrong: read the email before you reply.
- Limits: 10 requests a minute, 60 an hour.
