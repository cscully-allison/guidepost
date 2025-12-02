import anywidget
import traitlets
import pandas as pd
import numpy as np
import warnings
import json
import os
import sys
from .utils import convert_to_float, validate_and_clean_dataframe, extract_summary_statistics

class Campsite(anywidget.AnyWidget):
    _esm = os.path.join(os.path.dirname(__file__), "static", "campsite.js")
    _vis_data = traitlets.Dict({}).tag(sync=True)
    _summary_stats = traitlets.Dict({}).tag(sync=True)
    records = None
    vis_configs = traitlets.Dict({}).tag(sync=True)


    suppress_warnings = False
    
    @property
    def records(self):
        return self._vis_data
    
    @records.setter
    def records(self, df):
        self._vis_data = self.load_data(df)

    def load_data(self, in_df):
        '''
            Load dataframe and extract summary statistics for visualization.
        '''
    # validate / coerce dataframe
        if not isinstance(in_df, pd.DataFrame):
            try:
                in_df = pd.DataFrame(in_df)
            except Exception:
                raise ValueError("in_df must be a pandas DataFrame or convertible to one")

        if not self.suppress_warnings and in_df.empty:
            warnings.warn("load_data called with an empty DataFrame")

        o_df, report = validate_and_clean_dataframe(in_df, self.suppress_warnings)
        self._summary_stats = extract_summary_statistics(o_df)

        return self._summary_stats