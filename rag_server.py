import json
import logging
from http.server import BaseHTTPRequestHandler, HTTPServer
import chromadb
from chromadb.utils import embedding_functions

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

print("Loading ChromaDB and SentenceTransformer...")
client = chromadb.PersistentClient(path="./chroma_db")
embedder = embedding_functions.SentenceTransformerEmbeddingFunction(model_name="all-mpnet-base-v2")
print("ChromaDB initialized.")

class RAGRequestHandler(BaseHTTPRequestHandler):
    def _send_response(self, response_data, status=200):
        try:
            self.send_response(status)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(response_data).encode('utf-8'))
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, OSError) as e:
            logging.warning(f"Could not send response, client disconnected: {e}")

    def _get_collection(self, name):
        return client.get_or_create_collection(name=name, embedding_function=embedder)

    def do_POST(self):
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length) if content_length > 0 else b'{}'
            data = json.loads(post_data)
            
            collection_name = data.get('collection', 'dnd_knowledge')
            col = self._get_collection(collection_name)

            if self.path == '/add':
                documents = data.get('documents', [])
                metadatas = data.get('metadatas', [])
                ids = data.get('ids', [])
                
                if documents:
                    col.upsert(documents=documents, metadatas=metadatas, ids=ids)
                    logging.info(f"Upserted {len(documents)} documents.")
                self._send_response({"status": "success"})
            
            elif self.path == '/query':
                query_texts = data.get('query_texts', [])
                n_results = data.get('n_results', 5)
                where_filter = data.get('where', {})  # Metadata filter
                if query_texts:
                    results = col.query(
                        query_texts=query_texts, 
                        n_results=n_results, 
                        where=where_filter if where_filter else None
                    )
                    logging.info(f"Queried collection '{collection_name}' with {len(query_texts)} queries.")
                    self._send_response({"results": results})
                else:
                    self._send_response({"results": {}})
            
            elif self.path == '/clear':
                try:
                    client.delete_collection(collection_name)
                    logging.info(f"Cleared collection '{collection_name}'.")
                except ValueError:
                    logging.warning(f"Collection '{collection_name}' does not exist.")
                self._send_response({"status": "cleared"})
            
            elif self.path == '/get_all':
                results = col.get()
                logging.info(f"Retrieved all documents from collection '{collection_name}'.")
                self._send_response({"results": results})
            
            else:
                self._send_response({"error": "Not found"}, 404)
        except Exception as e:
            logging.error(f"Error handling request: {e}")
            self._send_response({"error": str(e)}, 500)

    def log_message(self, format, *args):
        logging.info(f"{self.address_string()} - {format % args}")

def run(server_class=HTTPServer, handler_class=RAGRequestHandler, port=8766):
    server_address = ('127.0.0.1', port)
    httpd = server_class(server_address, handler_class)
    logging.info(f"RAG server running on port {port}...")
    httpd.serve_forever()

if __name__ == '__main__':
    run()