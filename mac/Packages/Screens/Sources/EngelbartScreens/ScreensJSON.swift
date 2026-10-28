import EngelbartCore
import EngelbartStore
import Foundation

// The app's RootModel keeps the projects, the trash and the library as the renderer had them (JSON from ShellBackend):
// these read that shape into the Store's types the screens draw, filling what a summary may leave out.

public enum ScreensJSON {
    static func decode<T: Decodable>(_ type: T.Type, _ json: JSONValue) -> T? {
        try? JSONDecoder().decode(T.self, from: Data(json.text().utf8))
    }
    static func filled(_ json: JSONValue, _ defaults: [String: JSONValue]) -> JSONValue {
        var object = json.object ?? [:]
        for (key, value) in defaults where object[key] == nil || object[key]?.isNull == true && !value.isNull { object[key] = value }
        return .object(object)
    }

    /// A project as listProjects sends it (id, name, workspaceCount, lastEdited, recent, libraryIds …).
    public static func project(_ json: JSONValue) -> PublicProject? {
        let id = json["id"]?.string ?? ""
        return decode(PublicProject.self, filled(json, ["slug": .string(id), "dir": "", "description": "", "workspaceCount": 0, "recent": [], "libraryIds": []]))
    }

    /// A project in the trash (id, name, deleted, expires, workspaceCount).
    public static func trashed(_ json: JSONValue) -> TrashedProject? {
        decode(TrashedProject.self, filled(json, ["deleted": "", "expires": "", "workspaceCount": 0]))
    }

    /// A library row (ipc library's snake_case shape).
    public static func row(_ json: JSONValue) -> LibraryRow? {
        decode(LibraryRow.self, filled(json, ["type": "", "created": "", "last_edited": "", "tags": []]))
    }
}

public extension HomeModel {
    /// The app's JSON lists (RootModel's projects, trashed, shownLibrary), read into the screen's types.
    func update(projectsJSON: [JSONValue], trashedJSON: [JSONValue], libraryJSON: [JSONValue], error: String) {
        update(projects: projectsJSON.compactMap(ScreensJSON.project), trashed: trashedJSON.compactMap(ScreensJSON.trashed),
               library: libraryJSON.compactMap(ScreensJSON.row), error: error)
    }
}
