# KAI Core 0.6.2

Plugin installation and update reviews now use a KAI-styled window with the same pearl background, cobalt buttons, typography and plugin icons as the app. Requested access appears as readable permission descriptions. Publisher fingerprints, plugin IDs and exact permission IDs remain available under expandable technical details.

Cancel, the close button and Escape dismiss the review without installing. Cancel receives initial keyboard focus. Long permission lists and descriptions scroll while the action buttons remain visible. Updates show both the installed and incoming versions.

The review is a separate sandboxed Core window with a narrow approval bridge. Plugin text is rendered as text, and the window loads only its bundled assets. The native process verifies the package before review and installs that same verified package only after approval from the exact review window and main document. Closing to tray, navigating Core, losing either renderer, or quitting cancels a pending review.

Install this Core preview manually. Plugin packages do not need updating for the new review window. Shared profile paths, saved data, model files and manual update behavior are unchanged.
