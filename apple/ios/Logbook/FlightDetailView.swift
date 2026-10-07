import SwiftUI

struct FlightDetailView: View {
    @Bindable var flight: Flight
    @State private var editing = false
    @State private var drafting = false
    @State private var draftError: String?

    var body: some View {
        List {
            Section {
                LabeledContent("Date", value: flight.date.formatted(date: .long, time: .omitted))
                LabeledContent("Route", value: flight.route)
                LabeledContent("Aircraft", value: [flight.aircraftType, flight.tailNumber].filter { !$0.isEmpty }.joined(separator: " · "))
                LabeledContent("Total", value: String(format: "%.1f h", flight.totalHours))
                LabeledContent("Dual / solo", value: String(format: "%.1f / %.1f h", flight.dualHours, flight.soloHours))
                LabeledContent("Landings", value: "\(flight.dayLandings) day · \(flight.nightLandings) night")
            }
            if let metar = flight.metarRaw {
                Section("Weather when logged") {
                    if let category = flight.flightCategory {
                        LabeledContent("Flight category", value: category)
                    }
                    Text(metar).font(.system(.footnote, design: .monospaced))
                }
            }
            if !flight.maneuvers.isEmpty {
                Section("Maneuvers") {
                    Text(flight.maneuvers.joined(separator: ", "))
                }
            }
            if !flight.notes.isEmpty {
                Section("Notes") { Text(flight.notes) }
            }
            Section {
                if flight.debrief != nil {
                    TextField("Debrief", text: Binding(
                        get: { flight.debrief ?? "" },
                        set: { flight.debrief = $0.isEmpty ? nil : $0 }
                    ), axis: .vertical)
                }
                if OnDeviceAI.isAvailable {
                    Button(flight.debrief == nil ? "Draft a debrief from my notes" : "Redraft") {
                        Task { await draft() }
                    }
                    .disabled(drafting || flight.notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if let draftError {
                    Text(draftError).font(.footnote).foregroundStyle(.red)
                }
            } header: {
                Text("Debrief")
            } footer: {
                Text(OnDeviceAI.isAvailable
                     ? "Drafted on this iPhone from your notes only. It is a study aid, not instruction: your instructor's feedback is what counts."
                     : "Debrief drafting needs iOS 26 or later with Apple Intelligence turned on.")
            }
        }
        .navigationTitle(flight.route)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button("Edit") { editing = true }
        }
        .sheet(isPresented: $editing) {
            FlightEditView(flight: flight)
        }
    }

    @MainActor
    private func draft() async {
        drafting = true
        draftError = nil
        defer { drafting = false }
        var context = "Aircraft: \(flight.aircraftType). Time: \(String(format: "%.1f", flight.totalHours)) hours. "
        context += "Landings: \(flight.dayLandings + flight.nightLandings). "
        if !flight.maneuvers.isEmpty { context += "Maneuvers practiced: \(flight.maneuvers.joined(separator: ", ")). " }
        if let category = flight.flightCategory { context += "Conditions: \(category). " }
        context += "\nStudent's own notes:\n\(flight.notes)"
        do {
            flight.debrief = try await OnDeviceAI.respond(
                instructions: """
                You organize a student pilot's own lesson notes into a short debrief with three headings: \
                Went well, To improve, Focus for next lesson. Use only what the notes say. \
                Do not add flying technique, procedures, numbers or safety advice of your own.
                """,
                prompt: context
            )
        } catch {
            draftError = error.localizedDescription
        }
    }
}
