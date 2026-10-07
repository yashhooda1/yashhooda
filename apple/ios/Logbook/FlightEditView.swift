import SwiftData
import SwiftUI

/// Add a new flight (`flight == nil`) or edit an existing one.
struct FlightEditView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    let flight: Flight?

    @State private var date = Date.now
    @State private var aircraftType = ""
    @State private var tailNumber = ""
    @State private var departure = ""
    @State private var arrival = ""
    @State private var totalHours = 1.0
    @State private var dualHours = 1.0
    @State private var soloHours = 0.0
    @State private var dayLandings = 1
    @State private var nightLandings = 0
    @State private var maneuvers: Set<String> = []
    @State private var notes = ""
    @State private var attachMetar = true
    @State private var saving = false

    var body: some View {
        NavigationStack {
            ThemedForm {
                Section("Flight") {
                    DatePicker("Date", selection: $date, displayedComponents: .date)
                    TextField("Aircraft type (C172)", text: $aircraftType)
                        .textInputAutocapitalization(.characters)
                    TextField("Tail number", text: $tailNumber)
                        .textInputAutocapitalization(.characters)
                    TextField("From (ICAO, e.g. KSGR)", text: $departure)
                        .textInputAutocapitalization(.characters).autocorrectionDisabled()
                    TextField("To (blank for local)", text: $arrival)
                        .textInputAutocapitalization(.characters).autocorrectionDisabled()
                }
                Section("Time") {
                    Stepper("Total: \(totalHours, specifier: "%.1f") h", value: $totalHours, in: 0...24, step: 0.1)
                    Stepper("Dual: \(dualHours, specifier: "%.1f") h", value: $dualHours, in: 0...24, step: 0.1)
                    Stepper("Solo: \(soloHours, specifier: "%.1f") h", value: $soloHours, in: 0...24, step: 0.1)
                }
                Section("Landings") {
                    Stepper("Day: \(dayLandings)", value: $dayLandings, in: 0...99)
                    Stepper("Night: \(nightLandings)", value: $nightLandings, in: 0...99)
                }
                Section("Maneuvers") {
                    ForEach(Maneuver.common, id: \.self) { item in
                        Toggle(item, isOn: Binding(
                            get: { maneuvers.contains(item) },
                            set: { on in if on { maneuvers.insert(item) } else { maneuvers.remove(item) } }
                        ))
                    }
                }
                Section {
                    TextField("What went well, what to fix", text: $notes, axis: .vertical)
                        .lineLimit(4...12)
                } header: {
                    Text("Notes")
                } footer: {
                    Text("Use the keyboard microphone to dictate.")
                }
                if flight == nil {
                    Section {
                        Toggle("Attach the current METAR", isOn: $attachMetar)
                    } footer: {
                        Text("Fetches the latest observation for the departure airport as you save. Log soon after landing for it to match the flight.")
                    }
                }
            }
            .navigationTitle(flight == nil ? "New flight" : "Edit flight")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(saving || departure.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear(perform: populate)
        }
    }

    private func populate() {
        guard let flight else { return }
        date = flight.date
        aircraftType = flight.aircraftType
        tailNumber = flight.tailNumber
        departure = flight.departure
        arrival = flight.arrival
        totalHours = flight.totalHours
        dualHours = flight.dualHours
        soloHours = flight.soloHours
        dayLandings = flight.dayLandings
        nightLandings = flight.nightLandings
        maneuvers = Set(flight.maneuvers)
        notes = flight.notes
    }

    @MainActor
    private func save() async {
        saving = true
        defer { saving = false }
        let target = flight ?? Flight()
        target.date = date
        target.aircraftType = aircraftType.trimmingCharacters(in: .whitespaces)
        target.tailNumber = tailNumber.trimmingCharacters(in: .whitespaces)
        target.departure = departure.trimmingCharacters(in: .whitespaces).uppercased()
        target.arrival = arrival.trimmingCharacters(in: .whitespaces).uppercased()
        target.totalHours = totalHours
        target.dualHours = dualHours
        target.soloHours = soloHours
        target.dayLandings = dayLandings
        target.nightLandings = nightLandings
        target.maneuvers = Maneuver.common.filter { maneuvers.contains($0) }
        target.notes = notes
        if flight == nil {
            if attachMetar, let metar = try? await Metar.latest(icao: target.departure) {
                target.metarRaw = metar.raw
                target.flightCategory = metar.category
            }
            context.insert(target)
        }
        dismiss()
    }
}
