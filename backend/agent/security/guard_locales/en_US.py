"""English Guard rules."""

import re

from agent.security.guard_patterns import GuardLocale


EN_US = GuardLocale(
    narration=re.compile(r"\b(?:I|I've|I have|we|we've|we have)\s+(?:read|checked|looked at|updated|created|saved|deleted|sent|moved|archived|renamed)\b|\b(?:done|completed|saved successfully|created successfully|updated successfully)\b", re.I),
    action_request=re.compile(r"\b(?:sort|reorder|pin|archive|change|rename|delete|add|move|organize|update|edit)\b", re.I),
    refusal=re.compile(r"\b(?:no need|don't need|not necessary|leave it as is|already (?:fine|good|done|correct))\b", re.I),
    intent=re.compile(r"\b(?:let me|i(?:'ll| will| am going to)|next i'll|then i'll)\b.*\b(?:check|search|read|create|save|delete|send|move|rename|edit|update|organize)\b", re.I),
    colon_intent=re.compile(r"^(?:(?:then|next|now|let me|i will|i'll)).*(?:move|copy|delete|edit|write|create|read|check|search|organize|rename|save|update).*:\s*$", re.I | re.S),
    question=re.compile(r"\?|\b(?:should i|do you want|would you like|can i|shall i|is it necessary)\b", re.I),
    tool_progress_prefixes=("Searching for the latest information", "Checking now", "Let me look that up"),
    narration_nudge="[System reminder: missing tool receipt] You claimed to perform an operation, but this round contains no matching tool call. Do not report an unverified result; call the appropriate tool now or explain why it cannot be done.",
    intent_nudge="[System reminder: action announced but not performed] You said you would perform an action, but made no tool call. Complete the tool call now, or ask for the missing confirmation or information.",
    decision_nudge="[System reminder: do not decide for the user] The user explicitly requested this change, but you declined it without a tool call. Perform it with the appropriate tool or ask what should be changed.",
    tool_required_nudge="Your previous turn only gave a progress update and made no tool call. Call the appropriate tool now, or clearly explain why it cannot be called.",
)
