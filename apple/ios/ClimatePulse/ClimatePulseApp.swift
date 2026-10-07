import SwiftUI

@main
struct ClimatePulseApp: App {
    var body: some Scene {
        WindowGroup {
            TabView {
                TrendsView()
                    .tabItem { Label("Trends", systemImage: "chart.line.uptrend.xyaxis") }
                HereView()
                    .tabItem { Label("Here", systemImage: "location") }
            }
            .hoodaTheme()
        }
    }
}
