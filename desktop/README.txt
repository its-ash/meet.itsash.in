Meet for macOS
==============

1. Drag Meet to the Applications folder.

2. Open Terminal and run this command:

   xattr -dr com.apple.quarantine /Applications/Meet.app

   This command removes the download flag. Then Gatekeeper lets Meet open.

3. Open Meet from the Applications folder.

Another method (no Terminal):

1. Try to open Meet one time. macOS stops it.
2. Open System Settings > Privacy & Security.
3. Find the message about Meet and click "Open Anyway".
4. Type your password and click "Open".

Meet asks for camera and microphone access. Click "Allow".
Your camera stays off until you turn it on.

Meet needs a Mac with Apple silicon (M1 or later).
