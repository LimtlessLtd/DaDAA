import asyncio

from aiohttp import web


def create_tts_routes(tts_service):
    """Thin HTTP adapter over TtsService - no Kokoro knowledge here. Synthesis is a blocking
    CPU-bound call, so it runs in the default executor rather than on the event loop."""
    routes = web.RouteTableDef()

    @routes.post('/synthesize')
    async def synthesize(request):
        data = await request.json()
        text = (data.get('text') or '').strip()
        voices = data.get('voices') or [{"name": "bm_george", "weight": 1.0}]
        speed = float(data.get('speed', 1.0))

        if not text:
            return web.Response(status=400, text='Missing "text"')

        try:
            wav_bytes = await asyncio.get_event_loop().run_in_executor(
                None, tts_service.synthesize, text, voices, speed
            )
        except Exception as e:
            return web.Response(status=500, text=str(e))

        return web.Response(body=wav_bytes, content_type='audio/wav')

    return routes
