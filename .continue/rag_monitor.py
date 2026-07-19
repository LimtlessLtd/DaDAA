#!/usr/bin/env python3
import requests
import json

RAG_SERVER_URL = "http://127.0.0.1:8766/query"

def query_rag(query_text, collection_name="dnd_knowledge", n_results=3):
    payload = {
        "collection": collection_name,
        "query_texts": [query_text],
        "n_results": n_results
    }
    
    try:
        response = requests.post(RAG_SERVER_URL, json=payload)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"\n[!] Failed to connect to RAG server: {e}")
        return None

def interactive_debugger():
    print("🧠 DaDAA RAG Debugger 🧠")
    print("Type your query to see what context the AI DM retrieves.")
    print("Type 'switch' to toggle between Lore/State and Transcripts.")
    print("Type 'exit' to quit.\n")
    
    collection = "dnd_knowledge"
    
    while True:
        prompt = f"\n[{collection}] Search > "
        query = input(prompt).strip()
        
        if query.lower() == 'exit':
            break
        elif query.lower() == 'switch':
            collection = "dnd_transcripts" if collection == "dnd_knowledge" else "dnd_knowledge"
            continue
        elif not query:
            continue
            
        data = query_rag(query, collection_name=collection)
        
        if data and data.get("results") and data["results"]["documents"][0]:
            docs = data["results"]["documents"][0]
            metas = data["results"]["metadatas"][0]
            dists = data["results"]["distances"][0] if "distances" in data["results"] else ["N/A"] * len(docs)
            
            for i, (doc, meta, dist) in enumerate(zip(docs, metas, dists)):
                source = meta.get("name") or meta.get("source", "Unknown")
                print(f"\n--- Result {i+1} (Distance: {dist}) ---")
                print(f"Source: {source}")
                print(f"Text: {doc[:300]}..." if len(doc) > 300 else f"Text: {doc}")
        else:
            print("\n[-] No relevant results found.")

if __name__ == "__main__":
    interactive_debugger()