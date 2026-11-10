import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// Organisation details (staff list, API keys, team code) are secrets, never in this public repo.
// Set them with: cf deploy --secrets-file .secrets.env   (.secrets.env is git-ignored)
export default defineConfig({
	worker: {
		name: "meeting-agent",
		compatibilityDate: "2026-11-04",
		entrypoint,
		env: {
			AI: bindings.ai(),                                // Whisper large-v3-turbo (Workers AI, free daily allowance)
			DB: bindings.d1({ name: "meeting-agent-db" }),     // meetings, transcript pieces, minutes, approvals
			ANTHROPIC_API_KEY: bindings.secret(),             // Claude, for the minutes
			TEAM_CODE: bindings.secret(),                     // shared code staff type once to get in
			ORG_CONFIG: bindings.secret(),                    // JSON: org_name, org_description, staff[], vocabulary[]
			GROQ_API_KEY: bindings.secret(),                  // Groq Whisper, backup transcriber (free tier)
			GROQ_MODEL: bindings.text("whisper-large-v3-turbo"),         // or "whisper-large-v3" (full model)
		},
	},
});
