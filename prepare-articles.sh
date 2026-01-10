#!/bin/bash

# Simple script to publish articles

echo "📝 Building articles from markdown..."
node build-posts.js

if [ $? -ne 0 ]; then
    echo "❌ Build failed. Please check the error above."
    exit 1
fi

echo ""
echo "✓ Articles built successfully!"
echo ""
