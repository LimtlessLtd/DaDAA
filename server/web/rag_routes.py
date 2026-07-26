import asyncio

from aiohttp import web


def create_rag_routes(rag_service):
    """Thin HTTP adapter over RagService - no ChromaDB knowledge here, just request/response
    translation. ChromaDB calls are blocking, so each one runs in the default executor to avoid
    stalling the event loop that the transcription WebSocket also runs on."""
    routes = web.RouteTableDef()

    async def _run(fn, *args):
        return await asyncio.get_event_loop().run_in_executor(None, fn, *args)

    @routes.post('/add')
    async def add(request):
        data = await request.json()
        collection = data.get('collection', 'dnd_knowledge')
        await _run(rag_service.add, collection, data.get('documents', []), data.get('metadatas', []), data.get('ids', []))
        return web.json_response({"status": "success"})

    @routes.post('/query')
    async def query(request):
        data = await request.json()
        collection = data.get('collection', 'dnd_knowledge')
        results = await _run(
            rag_service.query, collection, data.get('query_texts', []),
            data.get('n_results', 5), data.get('where') or None
        )
        return web.json_response({"results": results})

    @routes.post('/clear')
    async def clear(request):
        data = await request.json()
        collection = data.get('collection', 'dnd_knowledge')
        await _run(rag_service.clear, collection)
        return web.json_response({"status": "cleared"})

    @routes.post('/get_all')
    async def get_all(request):
        data = await request.json()
        collection = data.get('collection', 'dnd_knowledge')
        results = await _run(rag_service.get_all, collection)
        return web.json_response({"results": results})

    return routes
