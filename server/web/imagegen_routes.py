import asyncio

from aiohttp import web


def create_imagegen_routes(imagegen_service):
    """Thin HTTP adapter over ImageGenService - no Stable Diffusion knowledge here. Generation is
    a blocking GPU/CPU-bound call, so it runs in the default executor rather than on the event
    loop, the same way TtsService's synthesis does."""
    routes = web.RouteTableDef()

    @routes.post('/generate')
    async def generate(request):
        data = await request.json()
        prompt = (data.get('prompt') or '').strip()

        if not prompt:
            return web.Response(status=400, text='Missing "prompt"')

        try:
            png_bytes = await asyncio.get_event_loop().run_in_executor(
                None,
                imagegen_service.generate,
                prompt,
                data.get('negative_prompt'),
                data.get('width', 512),
                data.get('height', 512),
                data.get('steps', 1),
                data.get('guidance_scale', 0.0),
            )
        except Exception as e:
            return web.Response(status=500, text=str(e))

        return web.Response(body=png_bytes, content_type='image/png')

    return routes
