package com.personal.mangatranslator;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MangaNativePlugin.class);
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(0xFF1F5F8B);
        getWindow().setNavigationBarColor(0xFF1F5F8B);
    }
}
