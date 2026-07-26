import hashlib
import json
import os
import re
from threading import Timer

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

SUPPORTED_EXTENSIONS = {".txt", ".md", ".json"}
DEBOUNCE_DELAY = 2.0


class DocsIngestService:
    """Watches static lore files (docs/) and pushes them into RAG. Takes a RagService instance
    directly instead of calling it over HTTP - the two used to be separate processes talking
    over loopback for no real reason, now they're in the same process. docs/ doesn't currently
    exist in this project, so in practice this just watches nothing and costs ~nothing; it's
    kept so dropping static lore files in later works without any code changes."""

    def __init__(self, rag_service, watched_dirs=("./docs/",), collection="dnd_knowledge"):
        self._rag = rag_service
        self._watched_dirs = list(watched_dirs)
        self._collection = collection
        self._file_timers = {}
        self._observer = None

    def start(self):
        self._initial_ingestion()

        handler = _DocsChangeHandler(self)
        observer = Observer()
        watching_any = False
        for watched_dir in self._watched_dirs:
            if os.path.exists(watched_dir):
                observer.schedule(handler, path=watched_dir, recursive=True)
                watching_any = True

        if watching_any:
            observer.start()
            self._observer = observer
            print("-> Watching for lore file changes...")

    def stop(self):
        if self._observer:
            self._observer.stop()
            self._observer.join()

    def debounce_event(self, file_path):
        if file_path in self._file_timers:
            self._file_timers[file_path].cancel()
        timer = Timer(DEBOUNCE_DELAY, self.ingest_file, args=[file_path])
        self._file_timers[file_path] = timer
        timer.start()

    def ingest_file(self, file_path):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read()

            file_ext = os.path.splitext(file_path)[1].lower()
            if file_ext == ".json":
                documents = _json_to_natural_language(json.loads(content))
            elif file_ext in {".txt", ".md"}:
                documents = _chunk_by_paragraphs(content)
            else:
                documents = []

            if not documents:
                return

            metadatas = [{"source": file_path, "file_type": file_ext} for _ in documents]
            ids = [_hash_id(doc, file_path) for doc in documents]
            self._rag.add(self._collection, documents, metadatas, ids)
            print(f"-> Ingested: {file_path}")
        except Exception as e:
            print(f"-> Failed parsing {file_path}: {e}")

    def _initial_ingestion(self):
        print("-> Performing initial docs/ ingestion...")
        for watched_dir in self._watched_dirs:
            if not os.path.exists(watched_dir):
                continue
            for root, _, files in os.walk(watched_dir):
                for file in files:
                    if os.path.splitext(file)[1].lower() in SUPPORTED_EXTENSIONS:
                        self.ingest_file(os.path.join(root, file))


class _DocsChangeHandler(FileSystemEventHandler):
    def __init__(self, ingest_service):
        self._ingest_service = ingest_service

    def on_modified(self, event):
        self._maybe_ingest(event)

    def on_created(self, event):
        self._maybe_ingest(event)

    def _maybe_ingest(self, event):
        if not event.is_directory and os.path.splitext(event.src_path)[1].lower() in SUPPORTED_EXTENSIONS:
            self._ingest_service.debounce_event(event.src_path)


def _hash_id(content, source):
    return hashlib.sha256(f"{source}_{content}".encode('utf-8')).hexdigest()


def _chunk_by_paragraphs(text):
    return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]


def _json_to_natural_language(data, prefix=""):
    statements = []
    if isinstance(data, dict):
        for k, v in data.items():
            statements.extend(_json_to_natural_language(v, f"{prefix} {k}".strip()))
    elif isinstance(data, list):
        for item in data:
            statements.extend(_json_to_natural_language(item, prefix))
    else:
        statements.append(f"{prefix} is {data}.")
    return statements
