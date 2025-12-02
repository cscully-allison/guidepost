import anywidget
import traitlets
import pandas as pd
import numpy as np
import json
import os
import sys
from .utils import validate_and_clean_dataframe

class Guidepost(anywidget.AnyWidget):
    
    _esm = os.path.join(os.path.dirname(__file__), "static",  "guidepost.js")
    records = None
    _vis_data = traitlets.Dict({}).tag(sync=True)

    vis_configs = traitlets.Dict({}).tag(sync=True)
    cached_records_df = None
    
    selected_records = traitlets.Unicode("[]").tag(sync=True)
    records_df = pd.DataFrame()
    selection = None

    suppress_warnings = False
    
    @property
    def records(self):
        return self._vis_data

    @records.setter
    def records(self, df):
        self._vis_data = self.load_data(df)

    def load_data(self, in_df):
        '''
            Load dataframe in a safe way.
            Drop NAs, remove time deltas, report warnings
        '''

        in_cpy = in_df.copy()
        in_cpy.insert(0, 'gp_idx', range(0, len(in_cpy)))
        self.cached_records_df = in_cpy

        if sys.version_info.major < 3 or sys.version_info.minor < 12:
            warn_supported_version = False

        o_df, report = validate_and_clean_dataframe(in_cpy, self.suppress_warnings)
        
        self._vis_data = o_df.to_dict()
        return o_df.to_dict()
        
    @property
    def selection(self):
        return self.retrieve_selected_data()

    def retrieve_selected_data(self):
        if self.cached_records_df is None:
            raise ValueError("No data has been loaded yet. Please call load_data() first.")
        elif len(self.selected_records) == 0:
            return pd.DataFrame()  # Return empty DataFrame if no selection

        selected_records_idx = json.loads(self.selected_records)
        
        self.records_df = self.cached_records_df[self.cached_records_df['gp_idx'].isin(selected_records_idx)]
        
        #remove synthetic index
        return self.records_df.drop('gp_idx', axis=1)