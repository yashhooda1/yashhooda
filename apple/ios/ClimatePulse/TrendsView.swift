import Charts
import SwiftUI

struct TrendsView: View {
    @State private var store = ClimateStore()
    @State private var selected: String = "IAH"
    @State private var summary: String?
    @State private var summarizing = false

    private var station: Station? {
        store.stations.first { $0.code == selected } ?? store.stations.first
    }

    var body: some View {
        NavigationStack {
            Group {
                if let station {
                    content(station)
                } else if store.isLoading {
                    ProgressView("Loading ClimatePulse")
                } else {
                    ContentUnavailableView(
                        "No climate data",
                        systemImage: "thermometer.medium.slash",
                        description: Text(store.error ?? "Pull to refresh.")
                    )
                }
            }
            .navigationTitle("ClimatePulse")
            .task { if store.stations.isEmpty { await store.load() } }
            .refreshable { await store.load() }
        }
    }

    @ViewBuilder
    private func content(_ station: Station) -> some View {
        ThemedList {
            Section {
                Picker("Station", selection: $selected) {
                    ForEach(store.stations) { s in
                        Text(s.name).tag(s.code)
                    }
                }
                .onChange(of: selected) { summary = nil }
            }

            Section("Annual mean temperature") {
                Chart {
                    ForEach(station.years) { y in
                        LineMark(x: .value("Year", y.year), y: .value("Mean °F", y.meanF),
                                 series: .value("Series", "Observed"))
                            .foregroundStyle(Theme.green)
                    }
                    ForEach(station.years.filter { $0.trendF != nil }) { y in
                        LineMark(x: .value("Year", y.year), y: .value("Trend °F", y.trendF ?? y.meanF),
                                 series: .value("Series", "Trend"))
                            .foregroundStyle(Theme.orange)
                            .lineStyle(StrokeStyle(lineWidth: 2, dash: [5, 4]))
                    }
                }
                .chartYScale(domain: .automatic(includesZero: false))
                // Without an explicit domain the year axis starts at zero and the
                // whole record collapses into a sliver at the right edge.
                .chartXScale(domain: (station.years.first?.year ?? 1970)...(station.years.last?.year ?? 2026))
                .chartXAxis { AxisMarks(values: .automatic(desiredCount: 6)) { value in
                    AxisGridLine()
                    AxisValueLabel { if let year = value.as(Int.self) { Text(String(year)) } }
                } }
                .frame(height: 240)
                .accessibilityLabel("Annual mean temperature for \(station.name)")

                if let slope = station.slopePerDecade {
                    LabeledContent("Warming rate", value: String(format: "%+.2f °F per decade", slope))
                }
                if !station.trendReliable {
                    Label("Too few complete years for a reliable trend", systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let last = station.lastDataDate {
                    LabeledContent("Data through", value: last + (station.stale ? " (stale)" : ""))
                }
            }

            if OnDeviceAI.isAvailable {
                Section("On-device summary") {
                    if let summary {
                        Text(summary)
                    }
                    Button(summary == nil ? "Summarize this station" : "Regenerate") {
                        Task { await summarize(station) }
                    }
                    .disabled(summarizing)
                    Text("Written on this iPhone from the numbers above. It can be wrong; the chart is the source.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }

            Section {
                if store.isSeedFallback {
                    Label("The site is serving its fallback dataset", systemImage: "exclamationmark.triangle")
                }
                if let generated = store.generatedAt {
                    LabeledContent("Pipeline run", value: generated)
                }
                Link("Open the web dashboard", destination: URL(string: "https://www.yashhooda.ai/#climate")!)
            } footer: {
                Text("NOAA daily station data through a Bronze, Silver, Gold pipeline. A linear trend describes the record; it does not attribute a cause.")
            }
        }
    }

    private func summarize(_ station: Station) async {
        summarizing = true
        defer { summarizing = false }
        guard let first = station.years.first, let last = station.years.last else { return }
        let warmest = station.years.max { $0.meanF < $1.meanF }
        var facts = "Station: \(station.name). Record: \(first.year) to \(last.year). "
        facts += "First year mean: \(String(format: "%.1f", first.meanF)) F. "
        facts += "Latest year mean: \(String(format: "%.1f", last.meanF)) F (the latest year may be partial). "
        if let warmest { facts += "Warmest year: \(warmest.year) at \(String(format: "%.1f", warmest.meanF)) F. " }
        if let slope = station.slopePerDecade { facts += "Linear trend: \(String(format: "%+.2f", slope)) F per decade." }
        do {
            summary = try await OnDeviceAI.respond(
                instructions: "You write two plain sentences describing a temperature record. Use only the numbers given. Do not mention causes or make forecasts.",
                prompt: facts
            )
        } catch {
            summary = error.localizedDescription
        }
    }
}
