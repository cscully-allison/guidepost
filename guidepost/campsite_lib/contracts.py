"""Artifact contracts for code and visualization generation."""

code_artifact_contract = {
    "uncertainty_estimator": "bootstrap",
    "n_draws": 1000,
}

vis_artifact_contract = {
    "output_format": "vega_lite",
    "allowed_chart_types": [
        "density_plot",
        "interval_plot",
    ],
    "required_visual_elements": [
        "axes",
        "axis_labels",
        "reference_value",
        "uncertainty_encoding",
    ],
}
