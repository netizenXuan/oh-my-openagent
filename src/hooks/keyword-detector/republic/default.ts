export const REPUBLIC_PATTERN = /\b(repwork|republicwork)\b/i

export const REPUBLIC_MESSAGE = `<republic-work-mode>
REPUBLIC WORK MODE ENABLED.

Use the existing OMO Republic governance system as the execution layer for this request.

Operating rules:
- Read repository context and current Republic state before changing files.
- If no suitable persistent team exists, call republic_team_init with team_model="parliament_squad" and seat_allocation="auto", unless the user gave a different model or count.
- Allocate seats dynamically from the task shape. Seats are execution carriers, not just comments.
- Use republic_round_start for planner/executor/reviewer rounds, republic_publish/republic_wait for Commons communication, republic_contract for cross-module contracts, and republic_seat_update for status.
- Treat Republic seats as exclusive orchestration when parliament, squad, or parliament_squad is active. Do not create a second legacy OMO task/call_omo_agent decomposition.
- Use hard fields and concrete file/task IDs so weak models can be validated.
- Keep native-git and Republic records durable. Do not commit unless explicitly asked.
</republic-work-mode>`
