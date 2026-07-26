# server/core_server.py
#
# Single process hosting RAG (HTTP, port 8766), voice transcription (WebSocket, port 8765), TTS
# (HTTP, port 8767), and the docs/ lore file watcher - previously four separate processes
# (rag_server.py, server.py, rag_ingest.py, tts_server.py) across two Python venvs. Kokoro's
# phonemizer dependency (misaki) used to cap TTS at Python <3.13 while the rest of this project
# ran on a newer Python, forcing a second venv - now the whole project targets Python 3.10-3.12
# (see requirements.txt), so everything lives in one venv and one process. Each concern is a
# standalone service class with no HTTP/WS knowledge (see services/); this file's only job is to
# construct them and wire them to thin route adapters (see web/).
import asyncio
import logging

from aiohttp import web

from services.docs_ingest_service import DocsIngestService
from services.rag_service import RagService
from services.transcription_service import TranscriptionEngine
from services.tts_service import TtsService
from web.rag_routes import create_rag_routes
from web.transcription_ws import create_transcription_routes
from web.tts_routes import create_tts_routes

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

RAG_PORT = 8766
TRANSCRIPTION_PORT = 8765
TTS_PORT = 8767


async def main():
    print("-> Loading ChromaDB and SentenceTransformer...")
    rag_service = RagService()
    print("-> ChromaDB initialized.")

    docs_ingest = DocsIngestService(rag_service)
    docs_ingest.start()

    print("-> Loading faster-whisper and Silero VAD...")
    transcription_engine = TranscriptionEngine()
    print("-> Transcription engine ready.")

    print("-> Loading Kokoro TTS pipeline (British English)...")
    tts_service = TtsService()
    print("-> Kokoro TTS ready.")

    rag_app = web.Application()
    rag_app.add_routes(create_rag_routes(rag_service))

    transcription_app = web.Application()
    transcription_app.add_routes(create_transcription_routes(transcription_engine))

    tts_app = web.Application()
    tts_app.add_routes(create_tts_routes(tts_service))

    rag_runner = web.AppRunner(rag_app)
    transcription_runner = web.AppRunner(transcription_app)
    tts_runner = web.AppRunner(tts_app)
    await rag_runner.setup()
    await transcription_runner.setup()
    await tts_runner.setup()

    await web.TCPSite(rag_runner, '127.0.0.1', RAG_PORT).start()
    await web.TCPSite(transcription_runner, '127.0.0.1', TRANSCRIPTION_PORT).start()
    await web.TCPSite(tts_runner, '127.0.0.1', TTS_PORT).start()

    print(f"-> RAG server running on port {RAG_PORT}")
    print(f"-> Transcription server running on port {TRANSCRIPTION_PORT} (Voice Only)")
    print(f"-> TTS server running on port {TTS_PORT}")

    try:
        await asyncio.Event().wait()
    finally:
        docs_ingest.stop()


if __name__ == '__main__':
    asyncio.run(main())
