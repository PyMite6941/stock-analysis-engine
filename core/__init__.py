"""Shared analysis core — data fetching + metrics. No AI, no web framework.

Imported by both the FastAPI backend (online mode) and the Streamlit app
(offline mode). Keep this module free of any AI / Groq / OpenRouter code so the
offline path never depends on a network LLM.
"""

from . import data, metrics, indicators  # noqa: F401
