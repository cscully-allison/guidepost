# Guidepost

Guidepost is a Python library for visualizing High Performance Computing (HPC) job data in Jupyter notebooks. It turns a `pandas` DataFrame of job records into a single, linked, interactive overview — faceted heatmaps framed by histograms, a categorical bar chart, and a brushable color legend — so you can spot patterns in runtimes, queue waits, and resource usage, then export the exact records you care about back into Python.

![Annotated Guidepost visualization showing the data grouping name, color-by-categorical bar chart, and the current selection of records for export](https://i.postimg.cc/vTDMX2b3/temp-Image-MVb5ui.avif)

## Installation

```bash
pip install guidepost
```

## Quick start

```python
from guidepost import Guidepost
import pandas as pd

gp = Guidepost()
gp.load_data(pd.read_parquet("data/jobs_data.parquet"))

gp.vis_configs = {
    'x':           'start_time',       # x-axis (numeric or datetime)
    'y':           'queue_wait',       # y-axis (numeric)
    'color':       'nodes_requested',  # cell color (numeric)
    'color_agg':   'avg',              # aggregation for color
    'categorical': 'user',             # bar chart / filter
    'facet_by':    'partition'         # splits the data into groups
}

gp   # display in a notebook cell
```

Brush the heatmap or its histograms, then pull the selected rows back into Python:

```python
df = gp.retrieve_selected_data()   # or: gp.selection.dataframe
```

Input is a `pandas` DataFrame with at least three numeric and two categorical columns (datetime columns are supported on the x-axis).

## Documentation

Full documentation lives in the **[Guidepost Wiki](https://github.com/cscully-allison/guidepost/wiki)**:

- [Getting Started](https://github.com/cscully-allison/guidepost/wiki/Getting-Started)
- [Data Requirements and Type Detection](https://github.com/cscully-allison/guidepost/wiki/Data-Requirements-and-Type-Detection)
- [Configuration](https://github.com/cscully-allison/guidepost/wiki/Configuration)
- [Understanding the Views](https://github.com/cscully-allison/guidepost/wiki/Understanding-the-Views) — and the per-view interaction guides
- [Selecting and Exporting Data](https://github.com/cscully-allison/guidepost/wiki/Selecting-and-Exporting-Data)
- [API Reference](https://github.com/cscully-allison/guidepost/wiki/API-Reference)
- [FAQ and Troubleshooting](https://github.com/cscully-allison/guidepost/wiki/FAQ-and-Troubleshooting)

## Contributing

Contributions are welcome. Fork the repository, create a branch for your feature or bugfix, and open a pull request with a description of your changes.

## License

Guidepost is licensed under the MIT License. See the `LICENSE` file for details.

## Acknowledgments

Guidepost was developed under the auspices and with funding provided by the National Renewable Energy Laboratory (NREL), the National Science Foundation under NSF IIS-1844573 and IIS-2324465, and the Department of Energy under DE-SC0022044 and DE-SC0024635.

## Contact

For questions or feedback, reach out to the maintainer at [cscullyallison@sci.utah.edu].
