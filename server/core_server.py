# server/core_server.py
#
# Single process hosting RAG (HTTP, port 8766), voice transcription (WebSocket, port 8765), TTS
# (HTTP, port 8767), image generation (HTTP, port 8768), and the docs/ lore file watcher -
# previously four separate processes (rag_server.py, server.py, rag_ingest.py, tts_server.py)
# across two Python venvs. Kokoro's phonemizer dependency (misaki) used to cap TTS at Python
# <3.13 while the rest of this project ran on a newer Python, forcing a second venv - now the
# whole project targets Python 3.10-3.12 (see requirements.txt), so everything lives in one venv
# and one process. Each concern is a standalone service class with no HTTP/WS knowledge (see
# services/); this file's only job is to construct them and wire them to thin route adapters
# (see web/).
#
# Each service's port opens immediately after that service is constructed, rather than
# constructing all services first and opening all ports at the end - ImageGenService can be slow
# to construct (Stable Diffusion model load, possibly a large one-time download on first run),
# and batching would delay RAG/transcription/TTS becoming reachable on every boot for a reason
# that has nothing to do with them. ImageGenService is constructed last so the three
# latency-sensitive, already-relied-upon services are unaffected by how long it takes.
import asyncio
import logging

from aiohttp import web

from services.docs_ingest_service import DocsIngestService
from services.rag_service import RagService
from services.transcription_service import TranscriptionEngine
from services.tts_service import TtsService
from services.image_gen_service import ImageGenService
from web.rag_routes import create_rag_routes
from web.transcription_ws import create_transcription_routes
from web.tts_routes import create_tts_routes
from web.imagegen_routes import create_imagegen_routes

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

RAG_PORT = 8766
TRANSCRIPTION_PORT = 8765
TTS_PORT = 8767
IMAGEGEN_PORT = 8768


async def _serve(service_app, port):
    runner = web.AppRunner(service_app)
    await runner.setup()
    await web.TCPSite(runner, '127.0.0.1', port).start()


async def main():
    print("-> Loading ChromaDB and SentenceTransformer...")
    rag_service = RagService()
    print("-> ChromaDB initialized.")
    rag_app = web.Application()
    rag_app.add_routes(create_rag_routes(rag_service))
    await _serve(rag_app, RAG_PORT)
    print(f"-> RAG server running on port {RAG_PORT}")

    docs_ingest = DocsIngestService(rag_service)
    docs_ingest.start()

    print("-> Loading faster-whisper and Silero VAD...")
    transcription_engine = TranscriptionEngine()
    print("-> Transcription engine ready.")
    transcription_app = web.Application()
    transcription_app.add_routes(create_transcription_routes(transcription_engine))
    await _serve(transcription_app, TRANSCRIPTION_PORT)
    print(f"-> Transcription server running on port {TRANSCRIPTION_PORT} (Voice Only)")

    print("-> Loading Kokoro TTS pipeline (British English)...")
    tts_service = TtsService()
    print("-> Kokoro TTS ready.")
    tts_app = web.Application()
    tts_app.add_routes(create_tts_routes(tts_service))
    await _serve(tts_app, TTS_PORT)
    print(f"-> TTS server running on port {TTS_PORT}")

    print("-> Loading Stable Diffusion pipeline (this may involve a one-time model download)...")
    imagegen_service = ImageGenService()
    print("-> Image generation ready.")
    imagegen_app = web.Application()
    imagegen_app.add_routes(create_imagegen_routes(imagegen_service))
    await _serve(imagegen_app, IMAGEGEN_PORT)
    print(f"-> Image generation server running on port {IMAGEGEN_PORT}")

    try:
        await asyncio.Event().wait()
    finally:
        docs_ingest.stop()


if __name__ == '__main__':
    asyncio.run(main())
