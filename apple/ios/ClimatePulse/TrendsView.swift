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
        // Each fact is a full sentence with its own year. Handing the small
        // on-device model a list of "label: value" pairs made it splice the
        // record's date range onto the first-year figure.
        let partial = last.year == Calendar.current.component(.year, from: .now)
        var facts = "The station is \(station.name). "
        facts += "In \(first.year), the first year of the record, the annual mean temperature was \(String(format: "%.1f", first.meanF)) F. "
        facts += "In \(last.year), the latest year\(partial ? ", which is not finished yet," : ""), it was \(String(format: "%.1f", last.meanF)) F. "
        if let warmest { facts += "The warmest year was \(warmest.year) at \(String(format: "%.1f", warmest.meanF)) F. " }
        if let slope = station.slopePerDecade {
            facts += "Across the whole record the linear trend is \(String(format: "%+.2f", slope)) F per decade."
        }
        do {
            summary = try await OnDeviceAI.respond(
                instructions: "You describe a temperature record in three short plain sentences. Use only the facts given, keep every temperature attached to its own year, and include the trend per decade. Do not mention causes or make forecasts.",
                prompt: facts
            )
        } catch {
            summary = error.localizedDescription
        }
    }
}
