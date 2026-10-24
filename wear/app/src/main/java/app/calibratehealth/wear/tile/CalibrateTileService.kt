/** Cache-only Wear Tile rendering and application navigation. */

package app.calibratehealth.wear.tile

import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders
import androidx.wear.protolayout.DimensionBuilders
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.protolayout.material3.MaterialScope
import androidx.wear.tiles.Material3TileService
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import app.calibratehealth.wear.BuildConfig
import app.calibratehealth.wear.MainActivity
import app.calibratehealth.wear.data.local.CalibrateWearDatabase
import app.calibratehealth.wear.data.security.AndroidKeystoreTokenStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** A bounded, cache-only health summary; tapping anywhere hands richer actions to the app. */
class CalibrateTileService : Material3TileService() {
    override suspend fun MaterialScope.tileResponse(
        requestParams: RequestBuilders.TileRequest
    ): TileBuilders.Tile {
        val snapshot = runCatching {
            withContext(Dispatchers.IO) {
                CalibrateTileCacheReader(
                    CalibrateWearDatabase.get(this@CalibrateTileService),
                    AndroidKeystoreTokenStore(this@CalibrateTileService)
                ).latest()
            }
        }.getOrNull()
        val content = CalibrateTileFormatter.format(snapshot, System.currentTimeMillis())
        return TileBuilders.Tile.Builder()
            // Periodic cache-only renders keep the age label honest when no sync commit requests an update.
            .setFreshnessIntervalMillis(TILE_FRESHNESS_INTERVAL_MS)
            .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(layout(content)))
            .build()
    }

    private fun layout(content: CalibrateTileContent): LayoutElementBuilders.LayoutElement {
        val column = LayoutElementBuilders.Column.Builder()
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .addContent(text("CALIBRATE", TITLE_SIZE_SP, SECONDARY_COLOR, bold = true))
            .addContent(spacer(8f))
            .addContent(text(content.calorieLine, PRIMARY_SIZE_SP, PRIMARY_COLOR, bold = true))

        column.addContent(spacer(6f)).addContent(text(content.consumedLine, BODY_SIZE_SP, PRIMARY_COLOR))
        column.addContent(spacer(8f)).addContent(
            text(
                content.statusLine,
                STATUS_SIZE_SP,
                if (content.isStale) STALE_COLOR else SECONDARY_COLOR
            )
        )
        return LayoutElementBuilders.Box.Builder()
            .setWidth(DimensionBuilders.expand())
            .setHeight(DimensionBuilders.expand())
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
            .setModifiers(
                ModifiersBuilders.Modifiers.Builder()
                    .setBackground(
                        ModifiersBuilders.Background.Builder()
                            .setColor(ColorBuilders.argb(BACKGROUND_COLOR))
                            .build()
                    )
                    .setClickable(openAppClickable())
                    .build()
            )
            .addContent(column.build())
            .build()
    }

    private fun text(
        value: String,
        sizeSp: Float,
        color: Int,
        bold: Boolean = false
    ): LayoutElementBuilders.Text {
        val style = LayoutElementBuilders.FontStyle.Builder()
            .setSize(DimensionBuilders.sp(sizeSp))
            .setColor(ColorBuilders.argb(color))
        if (bold) {
            style.setWeight(
                LayoutElementBuilders.FontWeightProp.Builder()
                    .setValue(LayoutElementBuilders.FONT_WEIGHT_BOLD)
                    .build()
            )
        }
        return LayoutElementBuilders.Text.Builder()
            .setText(value)
            .setMaxLines(1)
            .setOverflow(LayoutElementBuilders.TEXT_OVERFLOW_ELLIPSIZE)
            .setFontStyle(style.build())
            .build()
    }

    private fun spacer(heightDp: Float): LayoutElementBuilders.Spacer =
        LayoutElementBuilders.Spacer.Builder()
            .setHeight(DimensionBuilders.dp(heightDp))
            .setWidth(DimensionBuilders.dp(1f))
            .build()

    private fun openAppClickable(): ModifiersBuilders.Clickable {
        val activity = ActionBuilders.AndroidActivity.Builder()
            .setPackageName(BuildConfig.APPLICATION_ID)
            .setClassName(MainActivity::class.java.name)
            .build()
        val action = ActionBuilders.LaunchAction.Builder()
            .setAndroidActivity(activity)
            .build()
        return ModifiersBuilders.Clickable.Builder()
            .setId("open_calibrate")
            .setOnClick(action)
            .build()
    }

    private companion object {
        const val BACKGROUND_COLOR = 0xFF101418.toInt()
        const val PRIMARY_COLOR = 0xFFF5F7F8.toInt()
        const val SECONDARY_COLOR = 0xFFB6C4CB.toInt()
        const val STALE_COLOR = 0xFFFFB4A8.toInt()
        const val TITLE_SIZE_SP = 11f
        const val PRIMARY_SIZE_SP = 24f
        const val BODY_SIZE_SP = 15f
        const val STATUS_SIZE_SP = 11f
        const val TILE_FRESHNESS_INTERVAL_MS = 60 * 60 * 1_000L
    }
}
