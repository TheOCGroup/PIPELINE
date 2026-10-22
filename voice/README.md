# Piper — Kokoro voice profile (candidate)

This agent's voice profile for the standalone OCG shared voice service
(**ocg-voice** repository, contract `ocg-tts/v1`). Ownership per the
founder decision of 2026-10-21: the shared Kokoro service is standalone
infrastructure; each agent's profile and integration live in the agent's
own canonical product — this one lives here, in PIPELINE (Piper's canonical product).

- `kokoro-profile.json` conforms to `contracts/profile.schema.json` in
  the ocg-voice repo.
- The profile is an **audition candidate**. It changes nothing live:
  the rollout flag (`OCG_PIPER_KOKORO_TTS_ENABLED`) defaults OFF, and the agent's existing
  provider remains wired as fallback/rollback.
- Activation path (founder-gated): founder listening approval → deploy
  the ocg-voice service → set `OCG_KOKORO_TTS_URL` + this product's own
  caller key (`OCG_KOKORO_TTS_KEY`) → flip `OCG_PIPER_KOKORO_TTS_ENABLED=true` in this
  product's env only.
- Promotion rule: the alternate may not be promoted to primary until
  primary-voice uniqueness is re-verified across all five OCG profiles
  and any displaced agent is re-auditioned (TED review, 2026-10-21).

**Spanish identity (known v1 limitation):** G, Aiden, TED, and ORION all share
the same Spanish voice (em_alex) — a Spanish-speaking caller hears the same
voice under different names. Piper alone has a distinct Spanish voice
(ef_dora). Splitting Spanish identities is a founder decision pending the
listening session.
