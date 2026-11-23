package dev.openhouse.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class VoiceModelsTest {
    private val sha = "b".repeat(64)
    private val base = "https://cdn.example.org/releases/voice/1/voice.json"
    private fun file(path: String, extra: String = "") = """{"path":"$path","sha256":"$sha","size":5$extra}"""
    private fun set(vararg files: String) = """{"schema":1,"version":"1","files":[${files.joinToString(",")}]}"""
    private val lib = file("node_modules/onnxruntime-node/package.json")
    private val vad = file("models/wake/opie.onnx")

    @Test fun refusesPathsOutsideItsFolder() {
        for (p in listOf("../rootfs/etc/passwd", "models/../../x", "/etc/x", "models", "bin/x", "models/a b", "models/./x"))
            assertThrows(p, IllegalArgumentException::class.java) { VoiceModels.parse(set(lib, vad, file(p)), base) }
    }

    @Test fun refusesPlainHttpAndOtherHosts() {
        assertThrows(IllegalArgumentException::class.java) { VoiceModels.parse(set(lib, vad), "http://cdn.example.org/voice.json") }
        assertThrows(IllegalArgumentException::class.java) { VoiceModels.parse(set(lib, file("models/x.onnx", ""","url":"http://elsewhere.example/x.onnx"""")), base) }
        // A tester's own computer, as for releases.
        assertEquals("http://10.0.2.2:8820/voice/1/models/wake/opie.onnx", VoiceModels.parse(set(lib, vad), "http://10.0.2.2:8820/voice/1/voice.json").files[1].url)
    }

    @Test fun needsTheLibraryAndModelsAndChecksums() {
        assertThrows(IllegalArgumentException::class.java) { VoiceModels.parse(set(vad), base) }
        assertThrows(IllegalArgumentException::class.java) { VoiceModels.parse(set(lib), base) }
        assertThrows(IllegalArgumentException::class.java) { VoiceModels.parse(set(lib, vad, vad), base) }
        assertThrows(IllegalArgumentException::class.java) { VoiceModels.parse(set(lib, """{"path":"models/x","sha256":"abc","size":1}"""), base) }
        assertThrows(IllegalArgumentException::class.java) { VoiceModels.parse("""{"schema":2,"version":"1","files":[$lib,$vad]}""", base) }
    }
}
