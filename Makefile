run:
	cd worker && npx wrangler dev & \
	cd frontend && npm run dev

build:
	cd frontend/wasm-signal && wasm-pack build --target web --out-dir ../src/wasm
	cd frontend && npm run build
	rm -rf docs
	cp -r frontend/dist docs
	touch docs/.nojekyll

deploy: build
	cd worker && npx wrangler deploy
	git checkout main
	git add -A
	git commit -m "$$(copilot -sp 'Analyze the staged git changes and generate a concise commit message. Output ONLY the commit message. Do not execute any commands. Do not include quotes, markdown, explanation, or bullet points.')"
	git push origin main
