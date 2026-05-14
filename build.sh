#!/bin/bash
DATE=$(date +%Y-%m-%d-%H%M)
sed -i "s/CACHE_VER = '[^']*'/CACHE_VER = '$DATE'/" sw.js
echo "✅ SW cache version set to $DATE"
