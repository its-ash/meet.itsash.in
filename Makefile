run:
	cd worker && npx wrangler dev & \
	cd frontend && npm run dev

build:
	rm -rf frontend/src/wasm frontend/src/enhancer
	cd frontend/wasm-signal && wasm-pack build --target web --out-dir ../src/wasm
	cd frontend/wasm-audio && cargo build --release --target wasm32-unknown-unknown
	mkdir -p frontend/src/enhancer
	cp frontend/wasm-audio/target/wasm32-unknown-unknown/release/wasm_audio.wasm frontend/src/enhancer/voice.wasm
	cd frontend && npm run build
	rm -rf docs
	cp -r frontend/dist docs
	touch docs/.nojekyll

run-mac:
	$(MAKE) -C desktop run-mac

deploy: build
	cd worker && npx wrangler deploy
	git checkout main
	git add -A
	git commit -m "$$(copilot -sp 'Analyze the staged git changes and generate a concise commit message. Output ONLY the commit message. Do not execute any commands. Do not include quotes, markdown, explanation, or bullet points.')"
	git push origin main
