#!/usr/bin/env python3
import os
import json
import time
import requests
import hashlib
import re
from threading import Timer
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

RAG_SERVER_URL = "http://127.0.0.1:8766/add"
WATCHED_DIRS = ["./docs/"] # Point this ONLY to static lore/rules folders
SUPPORTED_EXTENSIONS = {".txt", ".md", ".json"}
DEBOUNCE_DELAY = 2.0 

file_timers = {}

def generate_hash_id(content, source):
    unique_string = f"{source}_{content}"
    return hashlib.sha256(unique_string.encode('utf-8')).hexdigest()

def chunk_by_paragraphs(text):
    paragraphs = re.split(r"\n\s*\n", text)
    return [p.strip() for p in paragraphs if p.strip()]

def json_to_natural_language(data, prefix=""):
    statements = []
    if isinstance(data, dict):
        for k, v in data.items():
            statements.extend(json_to_natural_language(v, f"{prefix} {k}".strip()))
    elif isinstance(data, list):
        for item in data:
            statements.extend(json_to_natural_language(item, prefix))
    else:
        statements.append(f"{prefix} is {data}.")
    return statements

def ingest_data(documents, metadatas, collection_name="dnd_knowledge"):
    if not documents: return
    ids = [generate_hash_id(doc, meta.get("source", "unknown")) for doc, meta in zip(documents, metadatas)]
    
    payload = {
        "collection": collection_name,
        "documents": documents,
        "metadatas": metadatas,
        "ids": ids
    }
    try:
        response = requests.post(RAG_SERVER_URL, json=payload)
        response.raise_for_status()
    except requests.exceptions.RequestException as e:
        print(f"Ingestion error: {e}")

def ingest_file(file_path):
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

        file_ext = os.path.splitext(file_path)[1].lower()
        documents = []
        
        if file_ext == ".json":
            data = json.loads(content)
            documents = json_to_natural_language(data)
        elif file_ext in {".txt", ".md"}:
            documents = chunk_by_paragraphs(content)

        metadatas = [{"source": file_path, "file_type": file_ext} for _ in documents]
        ingest_data(documents, metadatas)
        print(f"Ingested: {file_path}")
    except Exception as e:
        print(f"Failed parsing {file_path}: {e}")

def debounce_event(file_path):
    if file_path in file_timers:
        file_timers[file_path].cancel()
    timer = Timer(DEBOUNCE_DELAY, ingest_file, args=[file_path])
    file_timers[file_path] = timer
    timer.start()

class FileChangeHandler(FileSystemEventHandler):
    def on_modified(self, event):
        if not event.is_directory and os.path.splitext(event.src_path)[1].lower() in SUPPORTED_EXTENSIONS:
            debounce_event(event.src_path)

    def on_created(self, event):
        if not event.is_directory and os.path.splitext(event.src_path)[1].lower() in SUPPORTED_EXTENSIONS:
            debounce_event(event.src_path)

def initial_ingestion():
    print("Performing initial file ingestion...")
    for watched_dir in WATCHED_DIRS:
        if not os.path.exists(watched_dir): continue
        for root, _, files in os.walk(watched_dir):
            for file in files:
                if os.path.splitext(file)[1].lower() in SUPPORTED_EXTENSIONS:
                    ingest_file(os.path.join(root, file))

if __name__ == "__main__":
    initial_ingestion()
    
    event_handler = FileChangeHandler()
    observer = Observer()
    for watched_dir in WATCHED_DIRS:
        if os.path.exists(watched_dir):
            observer.schedule(event_handler, path=watched_dir, recursive=True)
    observer.start()
    
    print("Watching for lore file changes...")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()