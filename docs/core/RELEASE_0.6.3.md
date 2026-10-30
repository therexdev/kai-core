# KAI Core 0.6.3

Fixes the Assistant plugin’s **Launch KAI** button opening an uninitialized desktop companion. Core now serves the companion’s main JavaScript file along with its other bundled assets. The previous asset scan missed the base `mascot.js` filename, causing a 404 in the installed Core app.

Plugin smoke tests now use Core’s actual UI directory, click the real launch button, and verify that the companion runtime loads and its controls initialize. The legacy UI fallback that concealed the missing asset is no longer used by these tests. The native Apps check also installs the signed Assistant and exercises launch from the embedded page, return navigation, draft continuity in the tray, and disabling the companion.

Install this Core preview manually; Assistant 0.2.0 does not need a separate update. Existing data, models, preferences and the desktop companion’s original interface are preserved.
