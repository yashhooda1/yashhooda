# iOS apps

Two small SwiftUI apps in one generated Xcode project.

```bash
brew install xcodegen
cd apple/ios && xcodegen generate && open HoodaApple.xcodeproj
```

In Xcode, pick a target (ClimatePulse or Logbook), set your team under Signing & Capabilities, and run on the iPhone. A free Apple ID works; builds signed that way expire after 7 days.

**These sources were written without a compiler and have never been built.** Treat the first build as part of the work: expect a handful of errors to fix.

| | ClimatePulse | Logbook |
| --- | --- | --- |
| Purpose | station trends from the ClimatePulse gold layer, plus conditions where you are | private flight-training logbook (hobby) |
| Data | `yashhooda.ai/api/climate`; Open-Meteo weather and air quality; api.weather.gov alerts (US only) | SwiftData on the device; aviationweather.gov METAR |
| Frameworks | SwiftUI, Swift Charts, CoreLocation | SwiftUI, SwiftData, Swift Charts |
| Network | read-only, no account, no keys | METAR lookup only |

Both use `Shared/OnDeviceAI.swift`, a wrapper over Apple's Foundation Models framework, for summaries that run on the phone. It needs iOS 26 or later with Apple Intelligence on; the buttons hide themselves otherwise. Deployment target is iOS 18.

Things to know:

- **ClimatePulse and Cloudflare.** The app calls the site API with a normal `URLSession` user agent. If Cloudflare challenges it, allow `/api/climate` in the bot rules.
- **Location** is rounded to two decimals (about 1 km) before it goes to the weather services, and is not stored.
- **Logbook is not an official logbook.** It is a personal study record; the endorsed logbook stays the record of truth.
- **METAR** is the latest observation at the moment a flight is saved, not a historical lookup. Flight category is computed in the app from ceiling and visibility.
- **Debriefs** reorganize your own notes. The prompt tells the model not to add technique or safety advice, and it can still get things wrong.
