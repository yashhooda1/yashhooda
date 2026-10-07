import SwiftData
import SwiftUI

@main
struct LogbookApp: App {
    var body: some Scene {
        WindowGroup {
            FlightListView()
                .tint(.green)
        }
        // Stored on the device only. There is no account, sync or server.
        .modelContainer(for: Flight.self)
    }
}
