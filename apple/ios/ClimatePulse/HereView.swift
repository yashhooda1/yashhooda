import SwiftUI

struct HereView: View {
    @State private var store = HereStore()

    var body: some View {
        NavigationStack {
            ThemedList {
                if store.locationDenied {
                    ContentUnavailableView(
                        "Location is off",
                        systemImage: "location.slash",
                        description: Text("Allow location for ClimatePulse in Settings to see conditions where you are.")
                    )
                } else {
                    if let c = store.conditions {
                        Section(store.placeName ?? "Current conditions") {
                            LabeledContent("Temperature", value: String(format: "%.0f °F", c.temperatureF))
                            if let v = c.feelsLikeF { LabeledContent("Feels like", value: String(format: "%.0f °F", v)) }
                            if let v = c.humidityPct { LabeledContent("Humidity", value: String(format: "%.0f%%", v)) }
                            if let v = c.windMph { LabeledContent("Wind", value: String(format: "%.0f mph", v)) }
                        }
                    }
                    if let air = store.air {
                        Section("Air quality") {
                            LabeledContent("US AQI", value: String(format: "%.0f · %@", air.usAQI, air.band))
                            if let pm = air.pm25 { LabeledContent("PM2.5", value: String(format: "%.1f µg/m³", pm)) }
                        }
                    } else if store.airUnavailable {
                        Section("Air quality") {
                            Text("Air quality is unavailable right now. Tap refresh to try again.")
                                .foregroundStyle(.secondary)
                        }
                    }
                    if store.conditions != nil {
                        Section("Active alerts") {
                            if !store.alertsCovered {
                                Text("Alerts come from the US National Weather Service and are not available for this location.")
                                    .foregroundStyle(.secondary)
                            } else if store.alerts.isEmpty {
                                Text("No active alerts.").foregroundStyle(.secondary)
                            } else {
                                ForEach(store.alerts) { alert in
                                    VStack(alignment: .leading, spacing: 4) {
                                        Label(alert.event, systemImage: "exclamationmark.triangle.fill")
                                            .font(.headline)
                                        if let headline = alert.headline {
                                            Text(headline).font(.footnote).foregroundStyle(.secondary)
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if let error = store.error {
                        Section { Label(error, systemImage: "wifi.exclamationmark") }
                    }
                    if store.isLoading && store.conditions == nil {
                        Section { ProgressView("Finding conditions near you") }
                    }
                }
            }
            .navigationTitle("Here")
            .toolbar {
                Button("Refresh", systemImage: "arrow.clockwise") { store.refresh() }
                    .disabled(store.isLoading)
            }
            .task { store.refresh() }
        }
    }
}
