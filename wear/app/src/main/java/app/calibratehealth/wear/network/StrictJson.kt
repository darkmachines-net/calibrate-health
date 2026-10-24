/** Dependency-free bounded JSON parser and serializer for the watch network trust boundary. */

package app.calibratehealth.wear.network

/** Small dependency-free JSON model used at the network trust boundary and in plain JVM tests. */
sealed interface JsonValue {
    data class Object(val values: Map<String, JsonValue>) : JsonValue
    data class Array(val values: List<JsonValue>) : JsonValue
    data class StringValue(val value: String) : JsonValue
    data class NumberValue(val value: String) : JsonValue
    data class BooleanValue(val value: Boolean) : JsonValue
    data object Null : JsonValue
}

class InvalidJsonException(message: String) : IllegalArgumentException(message)

object StrictJson {
    private const val MAX_INPUT_CHARS = 128 * 1024
    private const val MAX_DEPTH = 24
    private const val MAX_COLLECTION_ENTRIES = 128

    /** Parses bounded JSON with strict syntax, nesting, and collection limits at the network boundary. */
    fun parse(input: String): JsonValue {
        if (input.length > MAX_INPUT_CHARS) throw InvalidJsonException("JSON response is too large.")
        return Parser(input).parse()
    }

    /** Serializes the internal JSON model with escaped strings and deterministic object insertion order. */
    fun stringify(value: JsonValue): String = buildString { appendValue(value) }

    /** Builds an ordered JSON object from key/value pairs. */
    fun objectOf(vararg entries: Pair<String, JsonValue>): JsonValue.Object =
        JsonValue.Object(linkedMapOf(*entries))

    /** Wraps text as a JSON string value for safe serialization. */
    fun string(value: String): JsonValue = JsonValue.StringValue(value)
    /** Wraps a numeric value in the internal JSON number representation. */
    fun number(value: Number): JsonValue = JsonValue.NumberValue(value.toString())
    /** Wraps a boolean in the internal JSON model. */
    fun boolean(value: Boolean): JsonValue = JsonValue.BooleanValue(value)
    /** Represents an optional string as a JSON string or explicit null. */
    fun nullableString(value: String?): JsonValue = value?.let(::string) ?: JsonValue.Null

    private fun StringBuilder.appendValue(value: JsonValue) {
        when (value) {
            is JsonValue.Object -> {
                append('{')
                value.values.entries.forEachIndexed { index, entry ->
                    if (index > 0) append(',')
                    appendQuoted(entry.key)
                    append(':')
                    appendValue(entry.value)
                }
                append('}')
            }
            is JsonValue.Array -> {
                append('[')
                value.values.forEachIndexed { index, item ->
                    if (index > 0) append(',')
                    appendValue(item)
                }
                append(']')
            }
            is JsonValue.StringValue -> appendQuoted(value.value)
            is JsonValue.NumberValue -> append(value.value)
            is JsonValue.BooleanValue -> append(if (value.value) "true" else "false")
            JsonValue.Null -> append("null")
        }
    }

    private fun StringBuilder.appendQuoted(value: String) {
        append('"')
        value.forEach { character ->
            when (character) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\b' -> append("\\b")
                '\u000C' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (character.code < 0x20) append("\\u%04x".format(character.code)) else append(character)
            }
        }
        append('"')
    }

    private class Parser(private val input: String) {
        private var position = 0

        fun parse(): JsonValue {
            skipWhitespace()
            val value = parseValue(0)
            skipWhitespace()
            if (position != input.length) invalid("Unexpected trailing content")
            return value
        }

        private fun parseValue(depth: Int): JsonValue {
            if (depth > MAX_DEPTH) invalid("JSON nesting is too deep")
            if (position >= input.length) invalid("Unexpected end of JSON")
            return when (input[position]) {
                '{' -> parseObject(depth + 1)
                '[' -> parseArray(depth + 1)
                '"' -> JsonValue.StringValue(parseString())
                't' -> parseLiteral("true", JsonValue.BooleanValue(true))
                'f' -> parseLiteral("false", JsonValue.BooleanValue(false))
                'n' -> parseLiteral("null", JsonValue.Null)
                '-', in '0'..'9' -> JsonValue.NumberValue(parseNumber())
                else -> invalid("Unexpected character")
            }
        }

        private fun parseObject(depth: Int): JsonValue.Object {
            position++
            skipWhitespace()
            val values = linkedMapOf<String, JsonValue>()
            if (consume('}')) return JsonValue.Object(values)
            while (true) {
                if (values.size >= MAX_COLLECTION_ENTRIES) invalid("JSON object has too many entries")
                if (position >= input.length || input[position] != '"') invalid("Object key must be a string")
                val key = parseString()
                if (values.containsKey(key)) invalid("Duplicate object key")
                skipWhitespace()
                expect(':')
                skipWhitespace()
                values[key] = parseValue(depth)
                skipWhitespace()
                if (consume('}')) return JsonValue.Object(values)
                expect(',')
                skipWhitespace()
            }
        }

        private fun parseArray(depth: Int): JsonValue.Array {
            position++
            skipWhitespace()
            val values = mutableListOf<JsonValue>()
            if (consume(']')) return JsonValue.Array(values)
            while (true) {
                if (values.size >= MAX_COLLECTION_ENTRIES) invalid("JSON array has too many entries")
                values += parseValue(depth)
                skipWhitespace()
                if (consume(']')) return JsonValue.Array(values)
                expect(',')
                skipWhitespace()
            }
        }

        private fun parseString(): String {
            expect('"')
            val result = StringBuilder()
            while (position < input.length) {
                val character = input[position++]
                when {
                    character == '"' -> return result.toString()
                    character == '\\' -> {
                        if (position >= input.length) invalid("Incomplete string escape")
                        when (val escaped = input[position++]) {
                            '"', '\\', '/' -> result.append(escaped)
                            'b' -> result.append('\b')
                            'f' -> result.append('\u000C')
                            'n' -> result.append('\n')
                            'r' -> result.append('\r')
                            't' -> result.append('\t')
                            'u' -> result.append(parseUnicodeEscape())
                            else -> invalid("Invalid string escape")
                        }
                    }
                    character.code < 0x20 -> invalid("Unescaped control character")
                    else -> result.append(character)
                }
            }
            invalid("Unterminated string")
        }

        private fun parseUnicodeEscape(): Char {
            if (position + 4 > input.length) invalid("Incomplete unicode escape")
            val encoded = input.substring(position, position + 4)
            position += 4
            return encoded.toIntOrNull(16)?.toChar() ?: invalid("Invalid unicode escape")
        }

        private fun parseNumber(): String {
            val start = position
            consume('-')
            if (consume('0')) {
                if (position < input.length && input[position].isDigit()) invalid("Leading zero in number")
            } else {
                consumeDigits(required = true)
            }
            if (consume('.')) consumeDigits(required = true)
            if (position < input.length && input[position] in "eE") {
                position++
                if (position < input.length && input[position] in "+-") position++
                consumeDigits(required = true)
            }
            return input.substring(start, position)
        }

        private fun consumeDigits(required: Boolean) {
            val start = position
            while (position < input.length && input[position].isDigit()) position++
            if (required && start == position) invalid("Expected number digits")
        }

        private fun <T : JsonValue> parseLiteral(text: String, value: T): T {
            if (!input.regionMatches(position, text, 0, text.length)) invalid("Invalid literal")
            position += text.length
            return value
        }

        private fun skipWhitespace() {
            while (position < input.length && input[position] in " \t\r\n") position++
        }

        private fun consume(expected: Char): Boolean {
            if (position < input.length && input[position] == expected) {
                position++
                return true
            }
            return false
        }

        private fun expect(expected: Char) {
            if (!consume(expected)) invalid("Expected '$expected'")
        }

        private fun invalid(message: String): Nothing = throw InvalidJsonException("$message at character $position.")
    }
}

internal fun JsonValue.requireObject(field: String = "response"): JsonValue.Object =
    this as? JsonValue.Object ?: throw InvalidJsonException("$field must be an object.")

internal fun JsonValue.Object.required(field: String): JsonValue =
    values[field] ?: throw InvalidJsonException("Missing $field.")

internal fun JsonValue.Object.requiredString(field: String): String =
    (required(field) as? JsonValue.StringValue)?.value
        ?: throw InvalidJsonException("$field must be a string.")

internal fun JsonValue.Object.optionalString(field: String): String? = when (val value = required(field)) {
    JsonValue.Null -> null
    is JsonValue.StringValue -> value.value
    else -> throw InvalidJsonException("$field must be a string or null.")
}

internal fun JsonValue.Object.requiredBoolean(field: String): Boolean =
    (required(field) as? JsonValue.BooleanValue)?.value
        ?: throw InvalidJsonException("$field must be a boolean.")

internal fun JsonValue.Object.optionalLong(field: String): Long? = when (val value = required(field)) {
    JsonValue.Null -> null
    is JsonValue.NumberValue -> value.value.toLongOrNull()
        ?: throw InvalidJsonException("$field must be an integer or null.")
    else -> throw InvalidJsonException("$field must be an integer or null.")
}

internal fun JsonValue.Object.optionalDouble(field: String): Double? = when (val value = required(field)) {
    JsonValue.Null -> null
    is JsonValue.NumberValue -> value.value.toDoubleOrNull()?.takeIf(Double::isFinite)
        ?: throw InvalidJsonException("$field must be a finite number or null.")
    else -> throw InvalidJsonException("$field must be a finite number or null.")
}

internal fun JsonValue.Object.requiredLong(field: String): Long =
    (required(field) as? JsonValue.NumberValue)?.value?.toLongOrNull()
        ?: throw InvalidJsonException("$field must be an integer.")

internal fun JsonValue.Object.optionalObject(field: String): JsonValue.Object? = when (val value = required(field)) {
    JsonValue.Null -> null
    is JsonValue.Object -> value
    else -> throw InvalidJsonException("$field must be an object or null.")
}

internal fun JsonValue.Object.requiredObject(field: String): JsonValue.Object =
    required(field) as? JsonValue.Object ?: throw InvalidJsonException("$field must be an object.")

internal fun JsonValue.Object.requiredArray(field: String): List<JsonValue> =
    (required(field) as? JsonValue.Array)?.values ?: throw InvalidJsonException("$field must be an array.")
