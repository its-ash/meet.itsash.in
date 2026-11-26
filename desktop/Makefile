PC ?= pc
REPO ?= its-ash/meet.itsash.in
VERSION := $(shell sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
OUT := dist
APP := $(OUT)/Meet.app

.PHONY: run run-mac app mac windows release

run:
	cargo run

run-mac: app
	-pkill -x meet
	open -n $(APP)

app:
	cargo build --release
	rm -rf $(APP)
	mkdir -p $(APP)/Contents/MacOS $(APP)/Contents/Resources
	cp target/release/meet $(APP)/Contents/MacOS/meet
	cp Info.plist $(APP)/Contents/Info.plist
	plutil -replace CFBundleShortVersionString -string "$(VERSION)" $(APP)/Contents/Info.plist
	plutil -replace CFBundleVersion -string "$(VERSION)" $(APP)/Contents/Info.plist
	cp icons/icon.icns $(APP)/Contents/Resources/icon.icns
	codesign --force --deep --options runtime --entitlements Entitlements.plist -s - $(APP)

mac: app
	rm -rf $(OUT)/Meet_$(VERSION).dmg $(OUT)/dmg
	mkdir -p $(OUT)/dmg
	cp -R $(APP) $(OUT)/dmg/
	ln -s /Applications $(OUT)/dmg/Applications
	cp README.txt $(OUT)/dmg/README.txt
	diskutil image create from --format UDZO --volumeName Meet $(OUT)/dmg $(OUT)/Meet_$(VERSION).dmg
	rm -rf $(OUT)/dmg

windows:
	ssh $(PC) "if not exist meet mkdir meet"
	cd .. && COPYFILE_DISABLE=1 tar -czf - --exclude desktop/target --exclude desktop/dist --exclude frontend/wasm-audio/target desktop frontend/wasm-audio | ssh $(PC) "tar -xzf - -C meet"
	ssh $(PC) "cd meet\desktop && cargo build --release"
	mkdir -p $(OUT)
	scp "$(PC):meet/desktop/target/release/meet.exe" $(OUT)/Meet_$(VERSION).exe

release: mac windows
	rm -rf $(OUT)/release
	mkdir -p $(OUT)/release
	cp $(OUT)/Meet_$(VERSION).dmg $(OUT)/release/Meet.dmg
	cp $(OUT)/Meet_$(VERSION).exe $(OUT)/release/Meet.exe
	gh release view v$(VERSION) -R $(REPO) >/dev/null 2>&1 || gh release create v$(VERSION) -R $(REPO) --title "Meet $(VERSION)" --notes "Desktop app for macOS (Apple silicon) and Windows (x64)."
	gh release upload v$(VERSION) -R $(REPO) --clobber $(OUT)/release/Meet.dmg $(OUT)/release/Meet.exe
