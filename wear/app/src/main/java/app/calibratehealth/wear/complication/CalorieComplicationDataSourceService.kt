/** System complication service that reads account-scoped cached calorie data without network work. */

package app.calibratehealth.wear.complication

import android.app.PendingIntent
import android.content.Intent
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationText
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.RangedValueComplicationData
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService
import app.calibratehealth.wear.MainActivity
import app.calibratehealth.wear.data.local.CalibrateWearDatabase
import app.calibratehealth.wear.data.security.AndroidKeystoreTokenStore
import app.calibratehealth.wear.tile.CalibrateTileCacheReader
import app.calibratehealth.wear.tile.CalibrateTileSnapshot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Cache-only calorie balance provider; watch-face rendering never initiates network work. */
class CalorieComplicationDataSourceService : SuspendingComplicationDataSourceService() {
    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? {
        val snapshot = readSnapshot()
        return buildData(
            request.complicationType,
            CalorieComplicationFormatter.format(snapshot, System.currentTimeMillis())
        )
    }

    override fun getPreviewData(type: ComplicationType): ComplicationData? = buildData(
        type,
        CalorieComplicationFormatter.format(
            CalibrateTileSnapshot(
                caloriesConsumed = 1_240,
                calorieTarget = 1_835,
                caloriesRemaining = 595,
                cachedAtEpochMs = 0L,
                planStatus = "available"
            ),
            nowEpochMs = 0L
        )
    )

    private suspend fun readSnapshot(): CalibrateTileSnapshot? = runCatching {
        withContext(Dispatchers.IO) {
            CalibrateTileCacheReader(
                CalibrateWearDatabase.get(this@CalorieComplicationDataSourceService),
                AndroidKeystoreTokenStore(this@CalorieComplicationDataSourceService)
            ).latest()
        }
    }.getOrNull()

    private fun buildData(type: ComplicationType, content: CalorieComplicationContent): ComplicationData? {
        val text = plainText(content.text)
        val title = plainText(content.title)
        val description = plainText(content.contentDescription)
        return when (type) {
            ComplicationType.SHORT_TEXT -> ShortTextComplicationData.Builder(text, description)
                .setTitle(title)
                .setTapAction(openAppAction())
                .build()
            ComplicationType.RANGED_VALUE -> RangedValueComplicationData.Builder(
                content.rangeValue,
                0f,
                content.rangeMaximum,
                description
            )
                .setText(text)
                .setTitle(title)
                .setTapAction(openAppAction())
                .build()
            else -> null
        }
    }

    private fun plainText(value: String): ComplicationText = PlainComplicationText.Builder(value).build()

    private fun openAppAction(): PendingIntent = PendingIntent.getActivity(
        this,
        OPEN_APP_REQUEST_CODE,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    private companion object {
        const val OPEN_APP_REQUEST_CODE = 3107
    }
}
