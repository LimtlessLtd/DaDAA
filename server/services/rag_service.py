import chromadb
from chromadb.errors import NotFoundError
from chromadb.utils import embedding_functions


class RagService:
    """Owns the ChromaDB client and embedding function. Pure data operations - no HTTP
    knowledge, so it can be called directly (from docs_ingest_service) or wrapped by a thin
    web route (see web/rag_routes.py) without caring which."""

    def __init__(self, persist_path="./chroma_db", embedding_model="all-mpnet-base-v2"):
        self._client = chromadb.PersistentClient(path=persist_path)
        self._embedder = embedding_functions.SentenceTransformerEmbeddingFunction(model_name=embedding_model)

    def _collection(self, name):
        return self._client.get_or_create_collection(name=name, embedding_function=self._embedder)

    def add(self, collection, documents, metadatas, ids):
        if not documents:
            return
        self._collection(collection).upsert(documents=documents, metadatas=metadatas, ids=ids)

    def query(self, collection, query_texts, n_results=5, where=None):
        if not query_texts:
            return {}
        return self._collection(collection).query(
            query_texts=query_texts,
            n_results=n_results,
            where=where or None
        )

    def clear(self, collection):
        # Deleting a collection that was never created (e.g. nothing has been added to it yet
        # this campaign) is a no-op, not a failure - /api/start_campaign clears all three
        # collections unconditionally every time, so this is the common case, not an edge case.
        # Chroma 1.x raises NotFoundError for this; older versions raised ValueError - catch both.
        try:
            self._client.delete_collection(collection)
            return True
        except (NotFoundError, ValueError):
            return False

    def get_all(self, collection):
        return self._collection(collection).get()
