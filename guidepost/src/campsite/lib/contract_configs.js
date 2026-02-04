export const code_artifact_contract = {
    uncertainty_estimator: 'boostrap',
    n_draws: 1000
} 

export const vis_artifact_contract = {
    output_format: 'vega_lite',
    allowed_chart_types: [
        'density_plot',
        'interval_plot'
    ],
    required_visual_elements: [
        'axes',
        'axis_labels',
        'reference_value',
        'uncertainty_encoding'
    ]
}

