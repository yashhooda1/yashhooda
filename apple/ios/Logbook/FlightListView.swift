import Charts
import SwiftData
import SwiftUI

struct FlightListView: View {
    @Environment(\.modelContext) private var context
    @Query(sort: \Flight.date, order: .reverse) private var flights: [Flight]
    @State private var adding = false

    private struct Month: Identifiable {
        let start: Date
        let hours: Double
        var id: Date { start }
    }

    private var months: [Month] {
        let calendar = Calendar.current
        var totals: [Date: Double] = [:]
        for flight in flights {
            let parts = calendar.dateComponents([.year, .month], from: flight.date)
            guard let start = calendar.date(from: parts) else { continue }
            totals[start, default: 0] += flight.totalHours
        }
        return Array(totals.map { Month(start: $0.key, hours: $0.value) }.sorted { $0.start < $1.start }.suffix(12))
    }

    var body: some View {
        NavigationStack {
            List {
                if flights.isEmpty {
                    ContentUnavailableView(
                        "No flights logged",
                        systemImage: "airplane",
                        description: Text("Tap + after your next lesson.")
                    )
                } else {
                    Section("Totals") {
                        LabeledContent("Total time", value: hours(flights.reduce(0) { $0 + $1.totalHours }))
                        LabeledContent("Dual received", value: hours(flights.reduce(0) { $0 + $1.dualHours }))
                        LabeledContent("Solo", value: hours(flights.reduce(0) { $0 + $1.soloHours }))
                        LabeledContent("Landings", value: String(flights.reduce(0) { $0 + $1.dayLandings + $1.nightLandings }))
                    }
                    if months.count > 1 {
                        Section("Hours by month") {
                            Chart(months) { month in
                                BarMark(x: .value("Month", month.start, unit: .month),
                                        y: .value("Hours", month.hours))
                                    .foregroundStyle(.green)
                            }
                            .frame(height: 160)
                            .accessibilityLabel("Flight hours by month")
                        }
                    }
                    Section("Flights") {
                        ForEach(flights) { flight in
                            NavigationLink {
                                FlightDetailView(flight: flight)
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(flight.route).font(.headline)
                                    Text("\(flight.date.formatted(date: .abbreviated, time: .omitted)) · \(flight.aircraftType) · \(hours(flight.totalHours))")
                                        .font(.footnote).foregroundStyle(.secondary)
                                }
                            }
                        }
                        .onDelete { offsets in
                            for index in offsets { context.delete(flights[index]) }
                        }
                    }
                }
            }
            .navigationTitle("Logbook")
            .toolbar {
                Button("Add flight", systemImage: "plus") { adding = true }
            }
            .sheet(isPresented: $adding) {
                FlightEditView(flight: nil)
            }
        }
    }

    private func hours(_ value: Double) -> String {
        String(format: "%.1f h", value)
    }
}
