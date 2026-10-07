import SwiftUI

/// The yashhooda.ai palette, so both apps look like the site they belong to.
/// Values mirror the CSS variables at the top of index.html.
enum Theme {
    static let green = Color(red: 0x4C / 255, green: 0xAF / 255, blue: 0x50 / 255)       // --green
    static let greenLight = Color(red: 0x81 / 255, green: 0xC7 / 255, blue: 0x84 / 255)  // --green-light
    static let background = Color(red: 0x0D / 255, green: 0x11 / 255, blue: 0x17 / 255)  // --bg
    static let card = Color(red: 0x1E / 255, green: 0x29 / 255, blue: 0x3B / 255)        // --bg-card
    static let elevated = Color(red: 0x2D / 255, green: 0x37 / 255, blue: 0x48 / 255)    // --bg-elevated
    static let muted = Color(red: 0x9C / 255, green: 0xA3 / 255, blue: 0xAF / 255)       // --text-muted
    static let hot = Color(red: 0xF8 / 255, green: 0x71 / 255, blue: 0x71 / 255)         // dashboard "hot" KPI
    static let blue = Color(red: 0x60 / 255, green: 0xA5 / 255, blue: 0xFA / 255)        // dashboard "blue" KPI
    static let orange = Color(red: 0xFB / 255, green: 0x92 / 255, blue: 0x3C / 255)      // trend lines
}

extension View {
    /// App-wide look: the site is dark-only, so the apps are too.
    func hoodaTheme() -> some View {
        self.tint(Theme.green).preferredColorScheme(.dark)
    }
}

/// A `List` on the site's background with card-coloured rows.
struct ThemedList<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        List {
            content().listRowBackground(Theme.card)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .tint(Theme.green)
    }
}

/// A `Form` with the same treatment.
struct ThemedForm<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        Form {
            content().listRowBackground(Theme.card)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .tint(Theme.green)
    }
}
