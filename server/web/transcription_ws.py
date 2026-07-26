import asyncio
import json

from aiohttp import web, WSMsgType

from services.transcription_service import VoiceSession

TIMEOUT_SECONDS = 0.8


def create_transcription_routes(engine):
    """Thin WebSocket adapter over TranscriptionEngine - owns nothing but the per-connection
    VoiceSession, which does the actual buffering/VAD/transcription work."""
    routes = web.RouteTableDef()

    @routes.get('/')
    async def websocket_handler(request):
        ws = web.WebSocketResponse(heartbeat=None)
        await ws.prepare(request)

        session = VoiceSession(engine)

        try:
            while True:
                try:
                    msg = await asyncio.wait_for(ws.receive(), timeout=TIMEOUT_SECONDS)
                except asyncio.TimeoutError:
                    await _maybe_send_transcript(ws, session, await session.flush_on_timeout())
                    continue

                if msg.type == WSMsgType.TEXT:
                    _handle_handshake(session, msg.data)
                    continue

                if msg.type == WSMsgType.BINARY and session.user_id:
                    await _maybe_send_transcript(ws, session, await session.feed(msg.data))
                    continue

                if msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.ERROR):
                    break
        except Exception as err:
            print(f"-> Transcription handler exception: {err}")
        finally:
            if not ws.closed:
                await ws.close()

        return ws

    return routes


def _handle_handshake(session, raw_message):
    try:
        payload = json.loads(raw_message)
        if isinstance(payload, dict) and payload.get('type') == 'handshake':
            session.user_id = payload.get('userId')
    except Exception:
        pass


async def _maybe_send_transcript(ws, session, text):
    if not text:
        return
    print(f"-> Transcription ({session.user_id}): {text}")
    await ws.send_str(json.dumps({"userId": session.user_id, "text": text}))
