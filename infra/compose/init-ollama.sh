#!/usr/bin/env sh
# Pull the default Rose models into a running Ollama container.
# Usage: docker compose exec ollama sh /init-ollama.sh
set -e
ollama pull llama3.1:8b-instruct
ollama pull nomic-embed-text
echo "Done. Available models:"
ollama list
